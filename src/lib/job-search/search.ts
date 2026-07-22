// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Job-search orchestrator — fan out enabled providers, filter, dedup, rank.
 *
 * Client-side keyword filter: Remotive and Arbeitnow ignore their `search=`
 * param (live-verified — the response is the same unfiltered latest-jobs feed
 * with or without it), so the honest backstop lives HERE: a posting survives
 * only if its title or description contains at least one significant query
 * term (title tokens + skills). Applied uniformly to every provider — harmless
 * for Jobicy (whose `tag=` does filter server-side), corrective for the rest —
 * so editing the query, including skill chips, actually changes the result set.
 *
 * URL trust boundary: feed JSON is untrusted input and `posting.url` is
 * rendered as an `<a href>`, so any posting whose url is not http(s) (e.g. a
 * `javascript:` url) is dropped here, covering every current and future
 * provider in one place.
 *
 * Graceful degradation: providers run through `Promise.allSettled`, so one feed
 * failing (network, CORS, malformed JSON) never rejects the whole search — its
 * postings are simply absent and its label is reported in `degradedProviders`
 * so the UI can note the missing source. A search only counts as a hard error
 * when EVERY provider rejected (`degradedProviders.length === providerCount`);
 * the panel derives that state from this result rather than a thrown error.
 *
 * The providers registry and the ranking tier are BOTH dynamic-imported (the
 * cascade-tier pattern) so the entry chunk stays small — adapters, their
 * HTML-strip helper, and jd-match's skill dictionary load only when the user
 * actually clicks Search.
 *
 * AbortSignal is threaded into every provider's `search()` so an in-flight
 * search can be cancelled or superseded by a newer one.
 *
 * Company boards (#533): when the caller passes selected companies, each one
 * joins the fan-out as an ordinary `JobProvider` wrapping the bounded pipeline
 * in `company-boards.ts`. Everything below this line therefore treats a company
 * board exactly like a keyless feed — same dedup, same url trust boundary, same
 * per-provider degradation — which is the point of routing them through the
 * provider interface. Two consequences worth stating outright:
 *
 *  - `matchesQuery` applies to company postings too. They already passed the
 *    #534 role-title filter, but the user's editable query is the final say on
 *    every source uniformly; special-casing company boards would make the query
 *    box silently mean different things for different cards.
 *  - The fan-out now runs through a concurrency limiter rather than a bare
 *    `Promise.allSettled`, because its width grows with the number of selected
 *    companies. `mapWithConcurrency` preserves allSettled's index-ordered,
 *    never-rejecting contract, so the degraded-provider mapping is unchanged.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobQuery } from "./query-builder.ts";
import type { JobPosting } from "./types.ts";
import type { RankedJob } from "./rank.ts";
import type { CompanyEntry } from "./company-registry.ts";
import { mapWithConcurrency } from "./concurrency.ts";

/**
 * Providers fetched at once. Bounds the burst when company boards join the
 * keyless feeds: the fan-out grows with the number of selected companies, and
 * a dozen simultaneous cross-origin fetches would let the slowest board gate
 * the search. Six keeps the common case (3 keyless + ~8 companies) moving
 * without saturating the connection pool.
 */
const PROVIDER_CONCURRENCY = 6;

export interface JobSearchResult {
  /** Postings ranked by fit descending (deduped across providers). */
  jobs: RankedJob[];
  /** Display labels of providers that failed — surfaced as a degraded notice.
   *  When this equals every provider, the search is a hard error. */
  degradedProviders: string[];
  /** How many providers were attempted (denominator for the error state). */
  providerCount: number;
}

/** Normalized dedup key: each of title/company lowercased and
 *  whitespace-collapsed independently, then joined — so trailing/among-word
 *  spacing differences between feeds collapse to the same key. */
function normalizeField(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupKey(posting: JobPosting): string {
  return `${normalizeField(posting.title)}::${normalizeField(posting.company)}`;
}

/** Only ever render feed-supplied urls that are plain web links. */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Tokens too generic to carry query intent on their own. */
const STOPWORDS = new Set([
  "and", "or", "the", "of", "for", "with", "in", "at", "to", "on", "an", "a",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Significant query terms as whole-word-ish case-insensitive patterns:
 * the tokens of EVERY query title (minus stopwords/short tokens) plus every
 * skill verbatim. `matchesQuery` ORs across these, so a posting survives when
 * it matches ANY title's tokens — the multi-title broadening from #539: an
 * exec whose prior roles were engineering-leadership titles keeps postings for
 * both facets, not just the most-recent title. Lookarounds instead of `\b` so
 * symbol-bearing skills ("C++", "Node.js") still match on word-ish edges.
 */
function buildQueryTermPatterns(query: JobQuery): RegExp[] {
  const terms = new Set<string>();
  for (const title of query.titles) {
    for (const token of title.toLowerCase().split(/[^a-z0-9+#.]+/)) {
      const term = token.replace(/^\.+|\.+$/g, "");
      if (term.length < 3 || STOPWORDS.has(term)) continue;
      terms.add(term);
    }
  }
  for (const skill of query.skills) {
    const term = skill.trim().toLowerCase();
    if (term) terms.add(term);
  }
  return [...terms].map(
    (term) => new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`),
  );
}

/** True when the posting's title or description contains ≥1 query term.
 *  A query with no significant terms (degenerate) filters nothing. */
function matchesQuery(posting: JobPosting, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return true;
  const haystack = `${posting.title}\n${posting.description}`.toLowerCase();
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Run the search. Never rejects on a provider failure — inspect the returned
 * `degradedProviders` / `providerCount` for partial or total failure. May
 * reject only if the dynamic chunk import itself fails (offline first-load);
 * the caller treats that as a hard error too.
 */
export async function searchJobs(
  query: JobQuery,
  parsed: HeuristicParsedResume,
  signal: AbortSignal,
  companies: readonly CompanyEntry[] = [],
): Promise<JobSearchResult> {
  const [{ getProviders }, { rankPostings }] = await Promise.all([
    import("./providers/index.ts"),
    import("./rank.ts"),
  ]);

  // Only pull in the company-board tier (and, through it, the role-keyword
  // taxonomy and the board cache) when the user actually selected companies —
  // an empty selection is byte-for-byte the pre-#533 keyless search.
  const companyProviders =
    companies.length > 0
      ? (await import("./company-boards.ts")).makeBoardProviders(companies, parsed)
      : [];

  const providers = getProviders(companyProviders);
  const settled = await mapWithConcurrency(
    providers,
    PROVIDER_CONCURRENCY,
    (p) => p.search(query, signal),
  );

  const degradedProviders: string[] = [];
  const seen = new Set<string>();
  const merged: JobPosting[] = [];
  const termPatterns = buildQueryTermPatterns(query);

  settled.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      degradedProviders.push(providers[i].label);
      return;
    }
    for (const posting of outcome.value) {
      if (!isSafeUrl(posting.url)) continue;
      if (!matchesQuery(posting, termPatterns)) continue;
      const key = dedupKey(posting);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(posting);
    }
  });

  return {
    jobs: rankPostings(parsed, merged, query),
    degradedProviders,
    providerCount: providers.length,
  };
}

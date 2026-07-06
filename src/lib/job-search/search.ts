// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobQuery } from "./query-builder.ts";
import type { JobPosting } from "./types.ts";
import type { RankedJob } from "./rank.ts";

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
 * the query title's tokens (minus stopwords/short tokens) plus every skill
 * verbatim. Lookarounds instead of `\b` so symbol-bearing skills ("C++",
 * "Node.js") still match on word-ish edges.
 */
function buildQueryTermPatterns(query: JobQuery): RegExp[] {
  const terms = new Set<string>();
  for (const token of query.title.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const term = token.replace(/^\.+|\.+$/g, "");
    if (term.length < 3 || STOPWORDS.has(term)) continue;
    terms.add(term);
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
): Promise<JobSearchResult> {
  const [{ getProviders }, { rankPostings }] = await Promise.all([
    import("./providers/index.ts"),
    import("./rank.ts"),
  ]);

  const providers = getProviders();
  const settled = await Promise.allSettled(
    providers.map((p) => p.search(query, signal)),
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
    jobs: rankPostings(parsed, merged),
    degradedProviders,
    providerCount: providers.length,
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Rank fetched postings against the parsed résumé, reusing the jd-match
 * machinery verbatim.
 *
 * Ranking parity (acceptance criterion): the fit % on a job card MUST equal
 * what the reused `JdMatch` detail view computes for the SAME posting. We
 * guarantee that by computing coverage ONCE per posting here — `extractJdTerms`
 * + `computeCoverage` — and packaging it into the exact `JdMatchResult` object
 * the `JdMatch` renderer consumes. The card reads `job.jdMatch.coverage` (score
 * + covered/missing) and the detail view is fed that same `job.jdMatch`, so the
 * two can never diverge (there is only one coverage computation).
 *
 * Location (#545): a SOFT rank boost, never a hard filter — a posting whose
 * location doesn't match the query is still ranked and shown, just lower, so a
 * strong non-local fit is never dropped. The boost is applied ONLY to sort
 * order, never to `RankedJob.score` itself — `score` stays byte-identical to
 * `jdMatch.coverage.score` so the ranking-parity guarantee above (score ===
 * what the card shows === what the detail view computes) holds whether or not
 * a location boost fired. When `query.location` is empty/undefined the sort is
 * byte-identical to pre-#545 behavior (plain coverage-score descending) — no
 * regression for the no-location case. "Remote" (or "Worldwide"/"Anywhere"/
 * "WFH") postings always count as a location match: a remote posting fits any
 * candidate location, so it shouldn't be penalized for lacking a specific
 * city.
 *
 * Dynamic-imported by `search.ts` so jd-match's skill dictionary stays out of
 * the entry chunk.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JdMatchResult } from "../jd-match/types.ts";
import { extractJdTerms } from "../jd-match/extract-jd-terms.ts";
import { computeCoverage } from "../jd-match/coverage.ts";
import type { JobPosting } from "./types.ts";
import type { JobQuery } from "./query-builder.ts";

/** The keyword arm of `JdMatchResult` — the only shape produced here. */
export type KeywordJdMatch = Extract<JdMatchResult, { path: "keyword" }>;

/** A posting paired with its (single) coverage computation. */
export interface RankedJob {
  posting: JobPosting;
  /** The exact object handed to `<JdMatch result={...} />` for detail. */
  jdMatch: KeywordJdMatch;
  /** Weighted coverage 0..100 — the card's "fit %". Mirror of
   *  `jdMatch.coverage.score`; surfaced flat for sort + card convenience. */
  score: number;
}

/**
 * Points added to a posting's SORT key (never its displayed `score`) when its
 * location matches `query.location` — see the location docblock above. Chosen
 * to outrank a small coverage-score gap between an otherwise-similar local and
 * non-local posting, without letting location swamp a large fit-quality
 * difference (a posting must still be a reasonably close fit to rise above a
 * much stronger non-local match).
 */
const LOCATION_BOOST = 10;

const REMOTE_PATTERN = /\b(remote|worldwide|anywhere|wfh)\b/i;

/** True for a posting location that reads as remote/location-agnostic — see
 *  the location docblock above for why these always count as a match. */
function isRemotePosting(location: string): boolean {
  return REMOTE_PATTERN.test(location);
}

/**
 * True when `postingLocation` should count as a match for `queryLocation`.
 * Compares the leading city/region token (text before the first comma) so
 * "Austin, TX" matches a feed's "Austin, TX, USA" without requiring an exact
 * string match, and falls back to a loose substring check either direction
 * for postings that don't follow the "City, ST" shape.
 */
function locationBoostMatches(queryLocation: string, postingLocation: string): boolean {
  if (isRemotePosting(postingLocation)) return true;
  const posting = postingLocation.trim().toLowerCase();
  const query = queryLocation.trim().toLowerCase();
  if (!posting || !query) return false;
  const postingCity = posting.split(",")[0].trim();
  const queryCity = query.split(",")[0].trim();
  return postingCity === queryCity || posting.includes(query) || query.includes(posting);
}

/**
 * Score every posting against `parsed` and return them sorted by fit
 * descending, with an optional location boost breaking ties toward postings
 * matching `query.location` (see the location docblock above). Ties keep
 * input order (stable sort), which preserves the provider/dedup order from
 * the fan-out.
 */
export function rankPostings(
  parsed: HeuristicParsedResume,
  postings: readonly JobPosting[],
  query?: Pick<JobQuery, "location">,
): RankedJob[] {
  const ranked = postings.map((posting): RankedJob => {
    const extracted = extractJdTerms(posting.description);
    const coverage = computeCoverage(parsed, extracted.all);
    const jdMatch: KeywordJdMatch = {
      path: "keyword",
      coverage,
      terms: extracted.all,
      nounsDropped: extracted.nounsDropped,
    };
    return { posting, jdMatch, score: coverage.score };
  });

  const queryLocation = query?.location?.trim();
  if (!queryLocation) {
    // No location signal → identical to pre-#545 behavior.
    return ranked.sort((a, b) => b.score - a.score);
  }
  // Decorate-sort-undecorate: compute the boosted key ONCE per posting (the
  // boost does a regex test + two splits), not O(n log n) times inside the
  // comparator. Sort is stable, so equal keys keep fan-out/dedup order.
  return ranked
    .map((job) => ({
      job,
      key:
        job.score +
        (locationBoostMatches(queryLocation, job.posting.location)
          ? LOCATION_BOOST
          : 0),
    }))
    .sort((a, b) => b.key - a.key)
    .map(({ job }) => job);
}

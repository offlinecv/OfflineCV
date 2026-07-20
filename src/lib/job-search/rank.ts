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
 * Dynamic-imported by `search.ts` so jd-match's skill dictionary stays out of
 * the entry chunk.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JdMatchResult } from "../jd-match/types.ts";
import { extractJdTerms } from "../jd-match/extract-jd-terms.ts";
import { computeCoverage } from "../jd-match/coverage.ts";
import type { JobPosting } from "./types.ts";

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
 * Score every posting against `parsed` and return them sorted by fit
 * descending. Ties keep input order (stable sort), which preserves the
 * provider/dedup order from the fan-out.
 */
export function rankPostings(
  parsed: HeuristicParsedResume,
  postings: readonly JobPosting[],
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
  return ranked.sort((a, b) => b.score - a.score);
}

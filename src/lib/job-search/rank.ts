// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Rank fetched postings against the parsed résumé, reusing the jd-match
 * machinery, and attach each posting's 0–5 STAR rating (#561).
 *
 * ── What the card shows (#561): a star rating, not a percentage ──
 * The old card headline was raw JD-term coverage as a "score/100". Its
 * denominator is how much the posting SAID, not how well the candidate fits, so
 * on a real senior résumé it compressed into single digits (max ~57, mean ~10)
 * and stopped discriminating. It is replaced by a calibrated, set-stretched star
 * rating computed in `rating.ts` (`rateJobs`) — see that module for the model.
 * `rank.ts` owns the raw signal extraction (coverage, comp, location, seniority)
 * and hands it to `rateJobs`; the resulting `JobRating` is attached to every
 * `RankedJob` and IS the sort order.
 *
 * ── Coverage parity (unchanged) ──
 * Coverage is still computed ONCE per posting here (`extractJdTerms` +
 * `computeCoverage`) and packaged into the exact `JdMatchResult` the `JdMatch`
 * detail view consumes, so the terms shown on the card and the detail view can
 * never disagree. `RankedJob.score` is still the raw coverage 0..100 — no longer
 * the card HEADLINE, but retained as the fitness input (via the
 * specificity-weighted base) and for the detail view's term legibility.
 *
 * ── Rating parity (the invariant that replaces the old "score === coverage") ──
 * The star rating is computed by `rateJobs` over the WHOLE result set at once
 * (it needs the set for the hybrid fitness stretch and the floor-less comp
 * percentile — see `rating.ts`). The card headline, the inline sub-stars, the
 * detail view, and the sort order all read the SAME attached `JobRating`, so they
 * cannot diverge. Sorting therefore happens AFTER rating, by `rating.overall`.
 *
 * ── The four rating signals this module extracts ──
 *   - fitness base — `coverage.score × specificityConfidence(termCount)`. The
 *     specificity factor (#561) discounts a high score resting on few extracted
 *     terms: a thin vague JD fully covered (100% over 6 terms) yields a smaller
 *     base than a well-specified JD covered 30/45, so it cannot outrank it.
 *   - location (#545) — a MATCH flag, remote always matching. Feeds a bounded
 *     minor axis in `rateJobs`; a non-local strong fit is never dropped, only
 *     edged by an equal-fit local one. No longer a flat sort-key boost (#570).
 *   - seniority (#562) — the ladder-rung DISTANCE between the query's derived
 *     level and the posting title's level, or null when there is no comparison
 *     (no query seniority, or an unrecognized title level). Feeds a minor axis;
 *     a level mismatch trims the rating a little, it no longer sinks a strong fit
 *     (the old flat −5/rung penalty dominated the compressed base — #570/#562).
 *   - compensation (#564) — `extractCompensation` runs ONCE here (the point
 *     downstream of board hydration where every posting's `description` is
 *     present), folded into `posting.compensation`. `belowFloor` is retained for
 *     the card badge; the comp AXIS in `rateJobs` rates the range vs the floor
 *     (or set-relative), and an absent comp simply drops out (silence neutral).
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
import { parseSeniorityLabel } from "./query-builder.ts";
import { seniorityRung } from "./seniority.ts";
import { extractCompensation, isBelowFloor, annualizedTop } from "./compensation.ts";
import { rateJobs, type JobRating, type RatingInput } from "./rating.ts";

/** The keyword arm of `JdMatchResult` — the only shape produced here. */
export type KeywordJdMatch = Extract<JdMatchResult, { path: "keyword" }>;

/** A posting paired with its coverage computation and its star rating. */
export interface RankedJob {
  posting: JobPosting;
  /** The exact object handed to `<JdMatch result={...} />` for detail. */
  jdMatch: KeywordJdMatch;
  /** Raw coverage 0..100 (`jdMatch.coverage.score`), surfaced flat. No longer
   *  the card headline (that is `rating`), but the fitness input and the detail
   *  view's term-legibility denominator. */
  score: number;
  /** The 0–5 star rating shown on the card (overall + sub-axes) — the sort key
   *  and the single source both card and detail read (#561). */
  rating: JobRating;
  /** True when `posting.compensation` is extracted, a query `compFloor` is set,
   *  AND the posting's top-of-range figure falls below it (#564). A SOFT signal
   *  — the card reads this to render a "below your floor" badge, never to hide
   *  the posting. Always false when no comp was extracted or no floor was set. */
  belowFloor: boolean;
  /** True when the QUERY carried a compensation floor. Distinct from
   *  `belowFloor` (which is per-posting and false both for "above the floor" and
   *  for "no floor at all"): the comp rating axis means two different things
   *  with and without a floor — measured against it, vs a bonus-only absolute
   *  curve — so the card must know which regime produced the number before it
   *  puts words to it (`describeRating`, #569). */
  compFloorSet: boolean;
}

/**
 * Half-saturation constant for the specificity confidence factor (#561): a
 * posting from which exactly this many terms were extracted has its coverage
 * score weighted at 0.5 when forming the fitness base. Fewer terms → the
 * coverage % rests on a thinner denominator, so it is discounted more; many
 * terms → the factor approaches 1 and the score stands on its own. So a
 * 100%-on-a-few-terms posting yields a smaller base than a well-specified
 * posting the résumé matches most of (100% over 6 terms → base ~37 vs 67% over
 * 45 terms → base ~55), which is what feeds the fitness axis in `rateJobs`.
 */
const SPECIFICITY_HALF_SATURATION = 10;

/**
 * Confidence multiplier in [0,1) applied to a posting's coverage score to form
 * its fitness base: `termCount / (termCount + SPECIFICITY_HALF_SATURATION)`.
 * Monotonically increasing in `termCount`; exactly 0 at `termCount === 0`, so a
 * posting with no extractable terms has base 0 (fitness 0, per #561's degenerate
 * case).
 */
function specificityConfidence(termCount: number): number {
  return termCount / (termCount + SPECIFICITY_HALF_SATURATION);
}

const REMOTE_PATTERN = /\b(remote|worldwide|anywhere|wfh)\b/i;

/** True for a posting location that reads as remote/location-agnostic — a remote
 *  posting fits any candidate location, so it always counts as a match. */
function isRemotePosting(location: string): boolean {
  return REMOTE_PATTERN.test(location);
}

/**
 * True when `postingLocation` should count as a match for `queryLocation`.
 * Compares the leading city/region token (text before the first comma) so
 * "Austin, TX" matches a feed's "Austin, TX, USA" without requiring an exact
 * string match, and falls back to a loose substring check either direction for
 * postings that don't follow the "City, ST" shape.
 */
function locationMatches(queryLocation: string, postingLocation: string): boolean {
  if (isRemotePosting(postingLocation)) return true;
  const posting = postingLocation.trim().toLowerCase();
  const query = queryLocation.trim().toLowerCase();
  if (!posting || !query) return false;
  const postingCity = posting.split(",")[0].trim();
  const queryCity = query.split(",")[0].trim();
  return postingCity === queryCity || posting.includes(query) || query.includes(posting);
}

/**
 * The ladder-rung DISTANCE between the query's seniority rung and the level
 * parsed out of a posting title (#562), or null when there is no comparison to
 * make: the query carried no derived seniority (`querySeniorityRung` undefined),
 * or the title carries no recognizable level (its rung is undefined). Null is
 * NEUTRAL — the seniority axis drops out of the rating rather than being treated
 * as a worst-case mismatch.
 */
function seniorityDistance(
  postingTitle: string,
  querySeniorityRung: number | undefined,
): number | null {
  if (querySeniorityRung === undefined) return null;
  const postingRung = seniorityRung(parseSeniorityLabel(postingTitle));
  if (postingRung === undefined) return null;
  return Math.abs(querySeniorityRung - postingRung);
}

/**
 * Build the raw `RatingInput` for one already-coverage-scored posting — the
 * bridge between rank.ts's signal extraction and `rateJobs`. Exported so the
 * `probe-jobs` diagnostic can reconstruct exactly what fed a rating without
 * re-deriving the constants (the single source of truth for the rating inputs).
 */
export function ratingInputFor(
  job: RankedJob,
  queryLocation: string | undefined,
  querySeniorityRung: number | undefined,
  compFloor: number | undefined,
): RatingInput {
  const comp = job.posting.compensation;
  return {
    base: job.score * specificityConfidence(job.jdMatch.terms.length),
    // Annualized top-of-range, or null when absent OR an implausible misparse —
    // a garbage $300/yr must not tank a strong fit via the comp axis (#561/#564).
    compMax: comp ? (annualizedTop(comp) ?? null) : null,
    compFloor,
    hasQueryLocation: queryLocation !== undefined,
    locationMatch:
      queryLocation !== undefined && locationMatches(queryLocation, job.posting.location),
    seniorityDistance: seniorityDistance(job.posting.title, querySeniorityRung),
  };
}

/**
 * Score every posting against `parsed`, rate it 0–5 stars, and return the
 * postings sorted by `rating.overall` descending. Coverage + comp are computed
 * once per posting; the rating is computed once over the whole set (`rateJobs`
 * needs the set — see `rating.ts`). Ties keep input order (stable sort), which
 * preserves the provider/dedup order from the fan-out.
 */
export function rankPostings(
  parsed: HeuristicParsedResume,
  postings: readonly JobPosting[],
  query?: Pick<JobQuery, "location" | "seniority" | "compFloor">,
): RankedJob[] {
  const compFloorSet = (query?.compFloor ?? 0) > 0;

  // Pass 1 — coverage + comp per posting (rating still unset; filled in pass 2).
  const ranked = postings.map((posting): RankedJob => {
    const extracted = extractJdTerms(posting.description);
    const coverage = computeCoverage(parsed, extracted.all);
    const jdMatch: KeywordJdMatch = {
      path: "keyword",
      coverage,
      terms: extracted.all,
      nounsDropped: extracted.nounsDropped,
    };
    // Extract compensation ONCE here (#564) — the point downstream of hydration
    // where every posting's `description` is guaranteed present regardless of
    // source. A posting that already carries `compensation` is left as-is.
    const compensation = posting.compensation ?? extractCompensation(posting.description);
    const withComp: JobPosting = compensation ? { ...posting, compensation } : posting;
    const belowFloor = isBelowFloor(compensation, query?.compFloor);
    return {
      posting: withComp,
      jdMatch,
      score: coverage.score,
      // Placeholder; overwritten in pass 2 once the whole set is known.
      rating: { overall: 0, fitness: 0, compensation: null, location: null, seniority: null },
      belowFloor,
      compFloorSet,
    };
  });

  const queryLocation = query?.location?.trim() || undefined;
  // Resolve the query's seniority to a ladder rung ONCE. `undefined` here (no
  // derived seniority, or an unmapped label) makes every posting's seniority
  // distance null — the axis drops out for the whole set.
  const querySeniorityRung = seniorityRung(query?.seniority);

  // Pass 2 — rate the whole set at once, attach, then sort by overall. Rating
  // needs the set (hybrid fitness stretch + floor-less comp percentile), so it
  // cannot be folded into pass 1.
  const inputs = ranked.map((job) =>
    ratingInputFor(job, queryLocation, querySeniorityRung, query?.compFloor),
  );
  const ratings = rateJobs(inputs);
  ranked.forEach((job, i) => {
    job.rating = ratings[i];
  });

  return ranked
    .map((job, i) => ({ job, i }))
    // Stable sort by overall rating descending; ties keep fan-out/dedup order.
    .sort((a, b) => b.job.rating.overall - a.job.rating.overall || a.i - b.i)
    .map(({ job }) => job);
}

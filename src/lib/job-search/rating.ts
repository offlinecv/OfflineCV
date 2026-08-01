// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Star rating model (#561) — turns a fetched posting's raw signals into a 0–5
 * star OVERALL rating plus per-axis sub-ratings, replacing the misleading fit
 * percentage on the job card.
 *
 * Why stars, not a percentage: the displayed fit % was raw JD-term coverage,
 * whose denominator is how much the posting SAID, not how well the candidate
 * fits. On a real senior résumé that number tops out ~57 and means ~10 — it
 * compresses into single digits, so the card reads "10% fit" for almost every
 * posting and stops discriminating. A star rating fixes that by being
 * calibrated to the base range real résumés actually produce, so a strong match
 * reads as a strong rating rather than as "57%".
 *
 * The OVERALL star is a weighted blend of four axes, each a fraction in [0,1]:
 *   - fitness      (always present) — the absolute saturating curve, see below
 *   - compensation (present iff comp was extracted) — vs the query's floor, or
 *                  a bonus-only absolute curve when the query set no floor
 *   - location     (present iff the query carried a location) — match nudge
 *   - seniority    (present iff the query + posting title yield a level) — nudge
 * An ABSENT axis is dropped and its weight redistributed over the present ones,
 * so a posting with no extracted comp is rated on the axes we actually know, not
 * penalized for our silence (the #564 "silence is neutral" rule, generalized).
 *
 * fitness is ABSOLUTE (#716): a saturating curve of the specificity-weighted
 * coverage base, `base / (base + FIT_HALF_SATURATION)`, and nothing else. It was
 * a HYBRID until #716 — that curve blended 40/60 against a set-RELATIVE stretch
 * that read the set's min/max and pulled the observed best match toward 5★. The
 * stretch made the SAME posting rate differently depending on what else happened
 * to be in the set: measured on one real résumé, a posting read 2.75★ "Partial
 * fit" on its own and 1.10★ "Weak fit" once a second, stronger job joined the
 * library. Both readings cannot be right, and the absolute one is — a fit rating
 * is a claim about ONE posting and ONE résumé, and an unrelated third posting
 * must not move it. The stretch existed (#561) because raw coverage compressed
 * into single digits and stopped discriminating; the saturating curve alone
 * already fixes that. Removing it changed no ORDERING (both halves were
 * monotonic in the base) — what changed is that the number is now portable.
 *
 * Why the soft axes are now FRACTIONS, weighted small (#570/#562 fix): the old
 * ranker added a FLAT location boost (+10) and subtracted FLAT seniority (−5/rung)
 * and comp (−8) penalties to a base that, on real compressed scores, tops out
 * around ~21. A flat ±10 is half that range, so location and seniority DOMINATED
 * fit (the probe measured a strong non-local fit sunk from rank ~1 to rank 9 by a
 * flat seniority penalty, and 446 location-over-fit inversions). Modeling them as
 * bounded fractions weighted 0.10 each makes them exactly what they were meant to
 * be — soft nudges that break a near-tie but can never bury a clear fit lead.
 *
 * Parity (the invariant that replaces rank.ts's old "score === coverage"):
 * `rateJobs` is the ONE place a rating is computed. The card headline, the
 * inline sub-stars, the detail view, and the sort order all read the SAME
 * `JobRating` object, so they can never diverge. Since #716 NO axis reads the
 * set — every rating is a pure function of its own `RatingInput`, so
 * `rateJobs([a, b])[0]` is exactly `rateJobs([a])[0]`. The array signature is a
 * convenience for the two callers that happen to hold a whole set, never a
 * dependency, and a 5★ now means "an excellent match for this résumé", not "the
 * best of what this search found".
 *
 * That also makes a rating cacheable for the first time — but nothing caches one
 * today, which is why there is still no algo-version stamp here mirroring
 * `ATS_SCORE_ALGO_VERSION`: that constant exists to invalidate a *stored* score
 * (`resume-library.ts`'s cache key), and nothing stores a rating. If a rating is
 * ever persisted, add the stamp then, with the consumer.
 */

/** The star scale. Ratings are real numbers in [0, MAX_STARS]; the display
 *  component rounds to half-stars, the sort uses the full precision. */
export const MAX_STARS = 5;

/**
 * Half-saturation constant for the absolute fitness curve,
 * `base / (base + FIT_HALF_SATURATION)` — and since #716 the ONLY parameter
 * shaping the fitness axis. A posting whose specificity-weighted coverage base
 * equals this value scores exactly 0.5, i.e. 2.5★. Sized against the base range
 * real résumés actually produce (ceiling ~21, mean ~7), not the theoretical
 * 0..100 coverage range: at 9, a base ~21 reads ~0.70 (3.5★) and a mean base ~7
 * reads ~0.44 (2.2★).
 *
 * It alone decides which BAND a posting's words come from — the cut-points in
 * `fitPhrase` are fixed star values, so moving this constant re-words every card
 * in the lane. #716 deliberately did NOT retune it: the two real postings
 * measured there (2.75★ "Partial fit" and 3.31★ "Strong fit") already land in
 * the bands their evidence warrants, and two points is not a calibration.
 */
const FIT_HALF_SATURATION = 9;

/** Overall-blend weights per axis (#561 "balanced fit + comp"): fitness and
 *  compensation are the two drivers, location and seniority are minor nudges.
 *  Applied only to PRESENT axes, then renormalized — see `rateJobs`. */
const WEIGHT_FITNESS = 0.45;
const WEIGHT_COMPENSATION = 0.35;
const WEIGHT_LOCATION = 0.1;
const WEIGHT_SENIORITY = 0.1;

/**
 * Half-saturation constant (annual USD) for the FLOOR-LESS compensation bonus
 * curve: a posting paying this much reaches the midpoint of the bonus band. At
 * 180k a typical strong-market salary reads as a solid bonus while a very high
 * package still has headroom toward the top. Only used when the query set NO
 * floor — see `compensationFraction`.
 */
const COMP_HALF_SATURATION = 180_000;

/** Per-rung falloff of the seniority fraction: an exact-level posting is 1.0,
 *  each rung of distance drops it by this much (floored at 0). At 0.2 a 1-rung
 *  miss is 0.8, a 5-rung gulf bottoms out — a gentle slope, because seniority is
 *  a minor axis (weight 0.1) and a soft nudge, never a filter. */
const SENIORITY_FRACTION_PER_RUNG = 0.2;

/** Location fraction for a non-matching (non-remote, different-city) posting: not
 *  zero — a non-local posting still has full fit value, location is only a
 *  preference — so a matched posting (1.0) edges it by a bounded margin under the
 *  small location weight. */
const LOCATION_FRACTION_NONMATCH = 0.5;

/** The per-axis star ratings for one posting. `overall` is the weighted blend;
 *  a `null` axis was not applicable to this posting/query and did not enter the
 *  blend (its weight was redistributed). All values are 0..MAX_STARS. */
export interface JobRating {
  overall: number;
  fitness: number;
  compensation: number | null;
  location: number | null;
  seniority: number | null;
}

/**
 * The raw per-posting signals the rating is computed from — produced by
 * `rank.ts` (which owns coverage/comp/location/seniority extraction) and handed
 * here so this module stays a pure transform with no knowledge of pdfjs, feeds,
 * or the jd-match dictionary.
 */
export interface RatingInput {
  /** Specificity-weighted coverage base (`coverage.score × specificityConfidence`),
   *  the same value rank.ts's fitness ordering rides on. */
  base: number;
  /** Top of the extracted compensation range (`comp.max ?? comp.min`), or null
   *  when no comp was extracted for this posting. */
  compMax: number | null;
  /** The query's optional compensation floor (annual, USD-assumed) — anchors the
   *  comp axis when set; when unset the comp axis is a bonus-only absolute curve
   *  (see `compensationFraction`). */
  compFloor: number | undefined;
  /** True when the query carried a location. `false` → the location axis is
   *  absent (null in the result) and its weight redistributes. */
  hasQueryLocation: boolean;
  /** Whether this posting's location matched the query (remote always matches).
   *  Only meaningful when `hasQueryLocation`. */
  locationMatch: boolean;
  /** Ladder-rung distance between the query's seniority and the posting title's
   *  level, or null when there is no comparison to make (no query seniority, or
   *  an unrecognized title level) — in which case the seniority axis is absent. */
  seniorityDistance: number | null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The fitness fraction ∈ [0,1): the saturating absolute curve of the base.
 *  Strictly increasing, 0 at base 0, and asymptotic to 1 — so a bigger base is
 *  always a bigger rating and no posting ever reaches a literal 5★ on fit. */
function absoluteFitness(base: number): number {
  return base / (base + FIT_HALF_SATURATION);
}

/**
 * The comp fraction ∈ [0,1] for a posting that HAS an extracted (annualized,
 * plausibility-screened) comp.
 *
 * With a floor SET, it is the top-of-range measured against the floor: at the
 * floor → 0.5, at/above twice the floor → 1.0, below → proportionally under 0.5
 * (a below-floor posting is a negotiation, not a disqualification — it sinks,
 * never vanishes). The floor is the user's EXPLICIT minimum, so this is the only
 * case comp is allowed to drag a posting below neutral.
 *
 * With NO floor, comp is a BONUS-ONLY absolute curve into [0.5, 1.0]: a strong
 * salary lifts the rating, an average/unknown one is neutral, and a merely-lower
 * salary is NEVER punished — the user set no minimum, so we must not infer one.
 * This is deliberately not a set-relative percentile: percentile made the
 * lowest-paying posting ~0★ even at a six-figure salary just because the set had
 * outliers, which BURIED a strong fit AND penalized a posting for disclosing pay
 * (a no-comp posting drops the axis and rates on fitness alone — so a disclosed
 * average salary must not rate below that, or disclosure is punished).
 */
function compensationFraction(compMax: number, compFloor: number | undefined): number {
  if (compFloor !== undefined && compFloor > 0) {
    return clamp01(compMax / compFloor / 2);
  }
  return 0.5 + 0.5 * (compMax / (compMax + COMP_HALF_SATURATION));
}

/** The seniority fraction ∈ [0,1] from the ladder-rung distance. */
function seniorityFraction(distance: number): number {
  return Math.max(0, 1 - Math.abs(distance) * SENIORITY_FRACTION_PER_RUNG);
}

/**
 * Rate postings, one `JobRating` per input, in the same order. This is the
 * SINGLE rating computation the whole lane reads — card, sub-stars, detail, and
 * sort order — so they cannot diverge.
 *
 * Since #716 every axis is a pure function of its OWN input, so this is a plain
 * per-item map and rating a posting alone gives the identical result to rating
 * it inside a set. The array signature survives because the two callers
 * (`rankPostings`, `rateSavedJobs`) hold a whole set anyway and routing them
 * through one call site is what keeps the two lanes' numbers identical.
 */
export function rateJobs(inputs: readonly RatingInput[]): JobRating[] {
  return inputs.map((input): JobRating => {
    // Fitness — the absolute saturating curve of the specificity-weighted base,
    // and nothing about the rest of `inputs`.
    const fitnessFrac = absoluteFitness(input.base);

    // Compensation — present only when a comp was extracted.
    const compFrac =
      input.compMax !== null
        ? compensationFraction(input.compMax, input.compFloor)
        : null;

    // Location — present only when the query carried a location.
    const locFrac = input.hasQueryLocation
      ? input.locationMatch
        ? 1
        : LOCATION_FRACTION_NONMATCH
      : null;

    // Seniority — present only when there is a level comparison to make.
    const senFrac =
      input.seniorityDistance !== null
        ? seniorityFraction(input.seniorityDistance)
        : null;

    // Weighted blend over the PRESENT axes, weights renormalized so an absent
    // axis neither counts nor penalizes.
    const axes: Array<[number, number | null]> = [
      [WEIGHT_FITNESS, fitnessFrac],
      [WEIGHT_COMPENSATION, compFrac],
      [WEIGHT_LOCATION, locFrac],
      [WEIGHT_SENIORITY, senFrac],
    ];
    let weighted = 0;
    let totalWeight = 0;
    for (const [w, frac] of axes) {
      if (frac === null) continue;
      weighted += w * frac;
      totalWeight += w;
    }
    const overallFrac = totalWeight > 0 ? weighted / totalWeight : 0;

    return {
      overall: MAX_STARS * overallFrac,
      fitness: MAX_STARS * fitnessFrac,
      compensation: compFrac === null ? null : MAX_STARS * compFrac,
      location: locFrac === null ? null : MAX_STARS * locFrac,
      seniority: senFrac === null ? null : MAX_STARS * senFrac,
    };
  });
}

/* ------------------------------------------------------------------------- *
 * Reason bands (#569)
 * ------------------------------------------------------------------------- */

/**
 * Band cut-points (in stars) for the per-axis WORDS the card shows in place of
 * per-axis sub-stars. Three reasons the words replaced the stars:
 *
 * 1. Three star rows in one card is three identical glyphs carrying three
 *    different meanings — nothing marks which one is the headline.
 * 2. `fitness` carries 0.45 of the blend and is the dominant axis, so a fit
 *    sub-star was ~the overall star shown twice.
 * 3. `location` and `seniority` were computed and never displayed at all. Words
 *    fit all four axes on one line where four star rows never could.
 *
 * Honesty note: the fitness phrasing used to be deliberately COMPARATIVE ("Top
 * fit here") because the axis was set-relative and an absolute claim would have
 * been unearned. #716 made the axis absolute, which makes the hedge dishonest in
 * the other direction — "top fit here" understates a posting the résumé genuinely
 * matches and overstates the best of a bad set — so the phrases now say what the
 * number means. The comp axis is absolute too, but its MEANING flips with
 * `hasCompFloor` (vs the user's floor when set, bonus-only otherwise), which is
 * why the caller must say which regime produced the number.
 */

/** Fitness band cut-points, in stars. Absolute since #716, so each reads
 *  straight off the curve — inverting `base / (base + FIT_HALF_SATURATION)`,
 *  ≥4★ needs base ≥ 36, ≥3★ needs base ≥ 13.5, ≥2★ needs base ≥ 6. "Excellent"
 *  is deliberately hard to reach: under the old set-relative stretch the best
 *  posting in ANY search got the top band by construction, and the word is worth
 *  more when it has to be earned against the curve instead.
 *
 *  Be aware, though, that "Excellent fit" is currently UNATTESTED on real data:
 *  base ≥ 36 is well past the ~21 ceiling `FIT_HALF_SATURATION`'s own note
 *  records for real résumés, and no measured posting has reached it. The band is
 *  not dead code — `base` ranges over the full coverage domain in the type, and
 *  `rating.test.ts` exercises it — but nobody has yet seen a posting earn it, so
 *  treat the top cut-point as unvalidated rather than as a calibrated target. */
const FIT_BAND_EXCELLENT = 4;
const FIT_BAND_STRONG = 3;
const FIT_BAND_PARTIAL = 2;

/** With a floor set, comp is measured against it: 2.5★ is exactly at the floor
 *  (`compMax / floor / 2`), so these bands read as multiples of the floor. Below
 *  the floor gets NO phrase — the card already shows a "Below your floor" badge,
 *  and saying it twice is noise. */
const PAY_BAND_WELL_ABOVE_FLOOR = 4.5;
const PAY_BAND_ABOVE_FLOOR = 3;
const PAY_BAND_AT_FLOOR = 2.5;

/** With NO floor set, comp is a bonus-only curve into [2.5★, 5★] — a low value
 *  means "nothing to shout about", never "bad pay" (the user set no minimum, so
 *  we must not infer one). Only the top of the band earns a phrase; below it the
 *  axis stays silent, matching the silence-is-neutral rule. */
const PAY_BAND_TOP = 4;
const PAY_BAND_STRONG = 3.2;

/** Seniority is 5★ at an exact level match and falls 1★ per ladder rung
 *  (`SENIORITY_FRACTION_PER_RUNG` × MAX_STARS). So ≥4.5 is an exact match and
 *  <3 is a gap of 2+ rungs — worth flagging; a single rung stays silent. */
const SENIORITY_BAND_MATCH = 4.5;
const SENIORITY_BAND_GAP = 3;

function fitPhrase(fitness: number): string {
  if (fitness >= FIT_BAND_EXCELLENT) return "Excellent fit";
  if (fitness >= FIT_BAND_STRONG) return "Strong fit";
  if (fitness >= FIT_BAND_PARTIAL) return "Partial fit";
  return "Weak fit";
}

function payPhrase(compensation: number, hasCompFloor: boolean): string | null {
  if (hasCompFloor) {
    if (compensation >= PAY_BAND_WELL_ABOVE_FLOOR) return "Pay well above your floor";
    if (compensation >= PAY_BAND_ABOVE_FLOOR) return "Pay above your floor";
    if (compensation >= PAY_BAND_AT_FLOOR) return "Pay at your floor";
    return null;
  }
  if (compensation >= PAY_BAND_TOP) return "Top pay";
  if (compensation >= PAY_BAND_STRONG) return "Strong pay";
  return null;
}

function levelPhrase(seniority: number): string | null {
  if (seniority >= SENIORITY_BAND_MATCH) return "Level match";
  if (seniority < SENIORITY_BAND_GAP) return "Level gap";
  return null;
}

/**
 * Turn a `JobRating` into the short "why" phrases the card renders as one line
 * in place of per-axis sub-stars (#569).
 *
 * Fitness always yields a phrase (the axis is always present). Every other axis
 * yields one only when it has something non-obvious to say — an absent axis, a
 * neutral comp, or a non-matching location contributes nothing, so a card with
 * no signal beyond fit shows exactly one phrase rather than a row of hedges.
 *
 * `hasCompFloor` must reflect whether the QUERY carried a floor, not whether
 * this posting has comp — it selects which of the two comp regimes the number
 * came from, and the two are not comparable.
 */
export function describeRating(
  rating: JobRating,
  opts: { hasCompFloor: boolean },
): string[] {
  const phrases = [fitPhrase(rating.fitness)];

  if (rating.compensation !== null) {
    const pay = payPhrase(rating.compensation, opts.hasCompFloor);
    if (pay) phrases.push(pay);
  }
  // Only a MATCH is worth saying: the posting's location is already printed on
  // the card, so "not where you asked" would be restating what the user can see.
  if (rating.location !== null && rating.location >= MAX_STARS) {
    phrases.push("Location match");
  }
  if (rating.seniority !== null) {
    const level = levelPhrase(rating.seniority);
    if (level) phrases.push(level);
  }

  return phrases;
}

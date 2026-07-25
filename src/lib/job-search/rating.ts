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
 * posting and stops discriminating. A star rating fixes both halves: it is
 * calibrated (a strong match reads as ~4–5★, not "57%"), and it is stretched
 * across the observed set so the good matches actually separate from the noise.
 *
 * The OVERALL star is a weighted blend of four axes, each a fraction in [0,1]:
 *   - fitness      (always present) — hybrid absolute+relative, see below
 *   - compensation (present iff comp was extracted) — vs floor, or set-relative
 *   - location     (present iff the query carried a location) — match nudge
 *   - seniority    (present iff the query + posting title yield a level) — nudge
 * An ABSENT axis is dropped and its weight redistributed over the present ones,
 * so a posting with no extracted comp is rated on the axes we actually know, not
 * penalized for our silence (the #564 "silence is neutral" rule, generalized).
 *
 * fitness is HYBRID (the chosen #561 direction): an ABSOLUTE saturating curve of
 * the specificity-weighted coverage base anchors the meaning (a strong match is
 * a strong match regardless of the rest of the set), then a set-RELATIVE stretch
 * lifts the observed top toward 5★ so the ranking still separates the good
 * matches even when the whole set is compressed. Because both halves are
 * monotonic in the base, the fitness axis — and thus the fitness-dominant
 * overall — preserves fit ordering.
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
 * `rateJobs` is the ONE place a rating is computed, over the whole result set at
 * once. The card headline, the inline sub-stars, the detail view, and the sort
 * order all read the SAME `JobRating` object, so they can never diverge. NOTE
 * the set-dependence this introduces: because the relative stretch reads the
 * set's min/max base, the identical posting can rate differently in a different
 * search — that is intended (a 5★ means "the best of what this search found",
 * not an absolute universal score) and is why the rating is computed per result
 * set, never cached per posting. That is also why there is no algo-version stamp
 * here mirroring `ATS_SCORE_ALGO_VERSION`: that constant exists to invalidate a
 * *stored* score (`resume-library.ts`'s cache key), and nothing stores a rating.
 * If a rating ever is persisted, add the stamp then, with the consumer.
 */

/** The star scale. Ratings are real numbers in [0, MAX_STARS]; the display
 *  component rounds to half-stars, the sort uses the full precision. */
export const MAX_STARS = 5;

/**
 * Half-saturation constant for the ABSOLUTE fitness curve:
 * `base / (base + FIT_HALF_SATURATION)`. A posting whose specificity-weighted
 * coverage base equals this value scores 0.5 absolute. Sized against the real
 * compressed base range (ceiling ~21, mean ~7): at 9, a top-of-set base ~21
 * reaches ~0.7 absolute (→ a strong ~3.5★ before the relative stretch lifts it
 * toward 5), while a mean base ~7 sits near ~0.44. Not the theoretical 0..100
 * coverage range — calibrated to what real résumés actually produce.
 */
const FIT_HALF_SATURATION = 9;

/**
 * Blend weight of the set-RELATIVE stretch against the ABSOLUTE curve in the
 * hybrid fitness fraction: `HYBRID_RELATIVE_WEIGHT · relative + (1 − it) ·
 * absolute`. At 0.6 the relative stretch leads (so the observed best match is
 * pulled decisively toward 5★ and the set separates) while the absolute curve
 * still contributes 40%, keeping a genuinely weak set from having its top posting
 * inflated to a perfect score purely for being the least-bad option.
 */
const HYBRID_RELATIVE_WEIGHT = 0.6;

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
   *  comp axis when set; when unset the comp axis is scored set-relative. */
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

/** Absolute fitness fraction ∈ [0,1): the saturating curve of the base. */
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
 * Rate every posting in a result set at once (the set is required for the hybrid
 * fitness stretch and the floor-less comp percentile). Returns one `JobRating`
 * per input, in the same order. This is the SINGLE rating computation the whole
 * lane reads — card, sub-stars, detail, and sort order — so they cannot diverge.
 */
export function rateJobs(inputs: readonly RatingInput[]): JobRating[] {
  if (inputs.length === 0) return [];

  // Set-level context for the hybrid fitness stretch.
  const absolutes = inputs.map((i) => absoluteFitness(i.base));
  const aMax = Math.max(...absolutes);
  const aMin = Math.min(...absolutes);
  const spread = aMax - aMin;

  return inputs.map((input, idx): JobRating => {
    // Fitness — hybrid absolute + set-relative stretch. When the set has no
    // spread (one posting, or all-equal bases) the stretch is undefined, so fall
    // back to the pure absolute curve.
    const absolute = absolutes[idx];
    const relative = spread > 0 ? (absolute - aMin) / spread : absolute;
    const fitnessFrac =
      HYBRID_RELATIVE_WEIGHT * relative + (1 - HYBRID_RELATIVE_WEIGHT) * absolute;

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
 * Honesty note: the fitness axis is SET-RELATIVE by construction (the hybrid
 * stretch reads the set's min/max — see this module's docblock), so the fitness
 * phrasing is deliberately comparative ("Top fit here"), never an absolute claim
 * about the posting. The comp axis, by contrast, IS absolute — so its phrasing
 * may make an absolute claim, but its MEANING flips with `hasCompFloor` (vs the
 * user's floor when set, bonus-only otherwise), which is why the caller must say
 * which regime produced the number.
 */
const FIT_BAND_TOP = 4;
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
  if (fitness >= FIT_BAND_TOP) return "Top fit here";
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

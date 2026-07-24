// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  rateJobs,
  describeRating,
  MAX_STARS,
  type JobRating,
  type RatingInput,
} from "./rating.ts";

/** A minimal input with only fitness present (no comp, no query location/seniority). */
function fitOnly(base: number): RatingInput {
  return {
    base,
    compMax: null,
    compFloor: undefined,
    hasQueryLocation: false,
    locationMatch: false,
    seniorityDistance: null,
  };
}

describe("rateJobs", () => {
  it("returns empty for an empty set", () => {
    expect(rateJobs([])).toEqual([]);
  });

  it("keeps every rating within [0, MAX_STARS]", () => {
    const ratings = rateJobs([fitOnly(0), fitOnly(7), fitOnly(21), fitOnly(100)]);
    for (const r of ratings) {
      expect(r.overall).toBeGreaterThanOrEqual(0);
      expect(r.overall).toBeLessThanOrEqual(MAX_STARS);
      expect(r.fitness).toBeGreaterThanOrEqual(0);
      expect(r.fitness).toBeLessThanOrEqual(MAX_STARS);
    }
  });

  it("with only fitness present, overall equals fitness (absent axes redistribute)", () => {
    const [r] = rateJobs([fitOnly(15)]);
    expect(r.compensation).toBeNull();
    expect(r.location).toBeNull();
    expect(r.seniority).toBeNull();
    expect(r.overall).toBeCloseTo(r.fitness, 10);
  });

  it("fitness is monotonic in the base", () => {
    const ratings = rateJobs([fitOnly(2), fitOnly(8), fitOnly(20)]);
    expect(ratings[0].fitness).toBeLessThan(ratings[1].fitness);
    expect(ratings[1].fitness).toBeLessThan(ratings[2].fitness);
  });

  it("HYBRID stretch lifts the observed top toward the max even on a compressed set", () => {
    // Mirror the real distribution: bases compressed into single digits, ceiling
    // ~21. The absolute curve alone would leave the top around 3.5★; the relative
    // stretch must pull it clearly higher.
    const bases = [0, 3, 5, 7, 9, 12, 15, 21];
    const ratings = rateJobs(bases.map(fitOnly));
    const top = ratings[ratings.length - 1].fitness;
    const bottom = ratings[0].fitness;
    // Top of a compressed set still reaches a strong rating.
    expect(top).toBeGreaterThan(4);
    // The degenerate base-0 posting bottoms out at exactly 0 stars.
    expect(bottom).toBe(0);
    // The set genuinely spreads (compression no longer flattens the ranking).
    expect(top - bottom).toBeGreaterThan(3);
  });

  it("falls back to the absolute curve when the set has no spread (single posting)", () => {
    const [one] = rateJobs([fitOnly(9)]);
    // base 9 → absolute 9/18 = 0.5 → 2.5★, no relative stretch to apply.
    expect(one.fitness).toBeCloseTo(2.5, 5);
  });

  it("does not penalize a posting for missing compensation — overall stays fitness-driven", () => {
    const strong = fitOnly(20); // no comp
    const [r] = rateJobs([strong]);
    expect(r.compensation).toBeNull();
    // A strong fit with unknown comp still rates strong, not dragged toward 0.
    expect(r.overall).toBeGreaterThan(3);
  });

  it("scores compensation against the floor: at floor ≈ 2.5★, well above ≈ 5★, below < 2.5★", () => {
    const base = 10;
    const atFloor: RatingInput = { ...fitOnly(base), compMax: 200000, compFloor: 200000 };
    const wellAbove: RatingInput = { ...fitOnly(base), compMax: 400000, compFloor: 200000 };
    const below: RatingInput = { ...fitOnly(base), compMax: 120000, compFloor: 200000 };
    const [a, w, b] = rateJobs([atFloor, wellAbove, below]);
    expect(a.compensation).toBeCloseTo(2.5, 5);
    expect(w.compensation).toBeCloseTo(5, 5);
    expect(b.compensation!).toBeLessThan(2.5);
    expect(b.compensation!).toBeGreaterThan(0);
  });

  it("scores floor-less compensation as a bonus-only absolute curve, never below neutral", () => {
    const mk = (comp: number): RatingInput => ({ ...fitOnly(10), compMax: comp });
    // No floor set: comp is a bonus. Higher pay → more stars, monotonically, and
    // NEVER below the neutral 2.5★ — a lower (but real) salary is not punished
    // when the user expressed no minimum. Not set-relative: each is scored on its
    // own absolute magnitude, so the lowest here is still a solid bonus, not 0.
    const ratings = rateJobs([mk(100000), mk(200000), mk(400000)]);
    expect(ratings[0].compensation!).toBeGreaterThanOrEqual(2.5);
    expect(ratings[0].compensation!).toBeLessThan(ratings[1].compensation!);
    expect(ratings[1].compensation!).toBeLessThan(ratings[2].compensation!);
    expect(ratings[2].compensation!).toBeLessThan(5);
  });

  it("does not punish disclosing an average salary vs hiding it (no floor)", () => {
    // A no-comp posting rates on fitness alone; a posting that DISCLOSES a decent
    // salary must not thereby rate lower. With the bonus-only curve, comp can only
    // lift or stay neutral, so the disclosed-comp posting is ≥ the no-comp one.
    const base = 12;
    const disclosed: RatingInput = { ...fitOnly(base), compMax: 170000 };
    const hidden: RatingInput = fitOnly(base);
    const [d, h] = rateJobs([disclosed, hidden]);
    expect(d.overall).toBeGreaterThanOrEqual(h.overall);
  });

  it("gives a lone floor-less comp a solid bonus, not a percentile 2.5★", () => {
    const [r] = rateJobs([{ ...fitOnly(10), compMax: 180000 }]);
    // 180k = COMP_HALF_SATURATION → 0.5 + 0.5·0.5 = 0.75 → 3.75★.
    expect(r.compensation).toBeCloseTo(3.75, 5);
  });

  it("location: matched = 5★, non-matched = a bounded 2.5★, absent query = null", () => {
    const base = 10;
    const matched: RatingInput = { ...fitOnly(base), hasQueryLocation: true, locationMatch: true };
    const nonMatched: RatingInput = { ...fitOnly(base), hasQueryLocation: true, locationMatch: false };
    const noQuery: RatingInput = fitOnly(base);
    const [m, n, q] = rateJobs([matched, nonMatched, noQuery]);
    expect(m.location).toBeCloseTo(5, 5);
    expect(n.location).toBeCloseTo(2.5, 5);
    expect(q.location).toBeNull();
    // The location nudge is minor: a matched posting edges an identical-fit
    // non-matched one, but only slightly (weight 0.1).
    expect(m.overall).toBeGreaterThan(n.overall);
    expect(m.overall - n.overall).toBeLessThan(0.5);
  });

  it("seniority: exact level = 5★, each rung of distance drops it, null distance = null", () => {
    const base = 10;
    const exact: RatingInput = { ...fitOnly(base), seniorityDistance: 0 };
    const oneOff: RatingInput = { ...fitOnly(base), seniorityDistance: 1 };
    const farOff: RatingInput = { ...fitOnly(base), seniorityDistance: 5 };
    const noLevel: RatingInput = fitOnly(base);
    const [e, o, f, nl] = rateJobs([exact, oneOff, farOff, noLevel]);
    expect(e.seniority).toBeCloseTo(5, 5);
    expect(o.seniority).toBeCloseTo(4, 5); // 1 - 1*0.2 = 0.8 → 4★
    expect(f.seniority).toBeCloseTo(0, 5); // 1 - 5*0.2 = 0 → 0★
    expect(nl.seniority).toBeNull();
  });

  it("a strong fit is NOT sunk by a seniority mismatch — the #562/#570 domination fix", () => {
    // The real pathology: a top-fit posting (base 21) one level off. Under the
    // old flat −15 penalty it fell from rank ~1 to rank ~9, below weak local
    // postings. As a minor fractional axis (weight 0.1) the mismatch can only
    // trim the overall a little — the strong fit still rates well above a weak
    // one that happens to be an exact level match.
    const strongOffLevel: RatingInput = { ...fitOnly(21), seniorityDistance: 2 };
    const weakExactLevel: RatingInput = { ...fitOnly(4), seniorityDistance: 0 };
    const [strong, weak] = rateJobs([strongOffLevel, weakExactLevel]);
    expect(strong.overall).toBeGreaterThan(weak.overall);
  });

  it("blends fitness and compensation as the two drivers (balanced fit + comp)", () => {
    // Same fitness; one has a strong comp, one a weak comp. The comp axis
    // (weight 0.35, second only to fitness) must move the overall meaningfully.
    const strongComp: RatingInput = { ...fitOnly(10), compMax: 400000, compFloor: 100000 };
    const weakComp: RatingInput = { ...fitOnly(10), compMax: 90000, compFloor: 100000 };
    const [s, w] = rateJobs([strongComp, weakComp]);
    expect(s.overall - w.overall).toBeGreaterThan(0.5);
  });
});

describe("describeRating", () => {
  const base: JobRating = {
    overall: 3,
    fitness: 3,
    compensation: null,
    location: null,
    seniority: null,
  };

  it("always yields a fit phrase, since the fitness axis is always present", () => {
    expect(describeRating({ ...base, fitness: 4.6 }, { hasCompFloor: false })).toEqual([
      "Top fit here",
    ]);
    expect(describeRating({ ...base, fitness: 3.2 }, { hasCompFloor: false })).toEqual([
      "Strong fit",
    ]);
    expect(describeRating({ ...base, fitness: 2.1 }, { hasCompFloor: false })).toEqual([
      "Partial fit",
    ]);
    expect(describeRating({ ...base, fitness: 0.4 }, { hasCompFloor: false })).toEqual([
      "Weak fit",
    ]);
  });

  it("phrases pay against the floor when the query set one", () => {
    const withPay = (compensation: number) =>
      describeRating({ ...base, compensation }, { hasCompFloor: true });
    expect(withPay(4.8)).toContain("Pay well above your floor");
    expect(withPay(3.5)).toContain("Pay above your floor");
    expect(withPay(2.6)).toContain("Pay at your floor");
  });

  it("says nothing about pay below the floor — the badge already does (issue 564)", () => {
    // Duplicating the "Below your floor" StatusBadge in words is noise.
    expect(describeRating({ ...base, compensation: 1.2 }, { hasCompFloor: true })).toEqual([
      "Strong fit",
    ]);
  });

  it("treats a floor-less comp as bonus-only: praise the top, never punish the rest", () => {
    const withPay = (compensation: number) =>
      describeRating({ ...base, compensation }, { hasCompFloor: false });
    expect(withPay(4.5)).toContain("Top pay");
    expect(withPay(3.4)).toContain("Strong pay");
    // The floor-less curve bottoms out at 2.5★ and means "nothing to shout
    // about", NOT "bad pay" — the user set no minimum, so we must not infer one.
    expect(withPay(2.6)).toEqual(["Strong fit"]);
  });

  it("speaks only for axes that are present", () => {
    // A null axis contributed nothing to the blend and must contribute no words.
    expect(describeRating(base, { hasCompFloor: true })).toEqual(["Strong fit"]);
  });

  it("names a location match but stays silent on a miss (the card prints the location)", () => {
    expect(
      describeRating({ ...base, location: MAX_STARS }, { hasCompFloor: false }),
    ).toContain("Location match");
    expect(
      describeRating({ ...base, location: MAX_STARS / 2 }, { hasCompFloor: false }),
    ).toEqual(["Strong fit"]);
  });

  it("flags an exact level match and a multi-rung gap, but not a single rung", () => {
    const withLevel = (seniority: number) =>
      describeRating({ ...base, seniority }, { hasCompFloor: false });
    expect(withLevel(5)).toContain("Level match");
    expect(withLevel(2)).toContain("Level gap");
    expect(withLevel(4)).toEqual(["Strong fit"]); // one rung off — not worth saying
  });

  it("reads every phrase off a real rateJobs result, in axis order", () => {
    const [rating] = rateJobs([
      {
        base: 21,
        compMax: 400000,
        compFloor: 100000,
        hasQueryLocation: true,
        locationMatch: true,
        seniorityDistance: 0,
      },
    ]);
    // base 21 is the observed top of the real compressed range → 3.5★ fitness.
    expect(describeRating(rating, { hasCompFloor: true })).toEqual([
      "Strong fit",
      "Pay well above your floor",
      "Location match",
      "Level match",
    ]);
  });
});

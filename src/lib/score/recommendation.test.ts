// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { getScoreRecommendation } from "./recommendation";
import type { AnonymousAtsScore } from "./score";

/** Build an AnonymousAtsScore with sensible "strong, no penalty" defaults, so
 *  each test overrides only the fields its branch depends on. */
function makeScore(overrides: {
  overall?: number;
  preLayoutOverall?: number;
  specificity?: Partial<AnonymousAtsScore["specificity"]>;
  structure?: Partial<AnonymousAtsScore["structure"]>;
  completeness?: Partial<AnonymousAtsScore["completeness"]>;
  layout?: Partial<AnonymousAtsScore["layout"]>;
} = {}): AnonymousAtsScore {
  return {
    overall: overrides.overall ?? 85,
    preLayoutOverall: overrides.preLayoutOverall ?? overrides.overall ?? 85,
    specificity: {
      score: 36,
      max: 40,
      gradable: true,
      metricBullets: 6,
      totalBullets: 10,
      ...overrides.specificity,
    },
    structure: {
      score: 27,
      max: 30,
      gradable: true,
      goodBullets: 9,
      totalBullets: 10,
      ...overrides.structure,
    },
    completeness: {
      score: 27,
      max: 30,
      gradable: true,
      missing: [],
      ...overrides.completeness,
    },
    layout: {
      triggers: [],
      multiplier: 1,
      scanned: false,
      ...overrides.layout,
    },
  };
}

describe("getScoreRecommendation", () => {
  it("flags a scanned PDF as the hard blocker, ahead of everything else", () => {
    const msg = getScoreRecommendation(
      makeScore({ layout: { scanned: true, multiplier: 0, triggers: ["scanned"] } }),
    );
    expect(msg).toMatch(/scanned image/i);
    expect(msg).toMatch(/text-based PDF/i);
  });

  it("leads with the layout penalty and names a single trigger", () => {
    const msg = getScoreRecommendation(
      makeScore({
        overall: 66,
        preLayoutOverall: 78,
        layout: { triggers: ["two_column"], multiplier: 0.85, scanned: false },
      }),
    );
    expect(msg).toContain("78/100");
    expect(msg).toContain("multi-column layout");
    expect(msg).toMatch(/fix that layout first/i);
  });

  it("names multiple layout triggers conjoined", () => {
    const msg = getScoreRecommendation(
      makeScore({
        preLayoutOverall: 80,
        layout: {
          triggers: ["two_column", "fonts_unmappable"],
          multiplier: 0.7,
          scanned: false,
        },
      }),
    );
    expect(msg).toContain("multi-column layout");
    expect(msg).toContain("and font encoding the parser can't read");
  });

  it("scanned takes priority even when other triggers are present", () => {
    const msg = getScoreRecommendation(
      makeScore({
        layout: {
          triggers: ["scanned", "two_column"],
          multiplier: 0,
          scanned: true,
        },
      }),
    );
    expect(msg).toMatch(/scanned image/i);
    expect(msg).not.toContain("multi-column");
  });

  it("points at Specificity when it is the weakest gradable dimension", () => {
    const msg = getScoreRecommendation(
      makeScore({
        overall: 70,
        specificity: { score: 8, max: 40 }, // ratio 0.20 — lowest
        structure: { score: 24, max: 30 }, // 0.80
        completeness: { score: 24, max: 30 }, // 0.80
      }),
    );
    expect(msg).toMatch(/add metrics/i);
    expect(msg).toContain("This is close"); // overall 70 → medium tier
  });

  it("points at Structure when it is the weakest gradable dimension", () => {
    const msg = getScoreRecommendation(
      makeScore({
        overall: 70,
        specificity: { score: 32, max: 40 }, // 0.80
        structure: { score: 6, max: 30 }, // 0.20 — lowest
        completeness: { score: 24, max: 30 }, // 0.80
      }),
    );
    expect(msg).toMatch(/tighten each bullet/i);
    expect(msg).toMatch(/action verb/i);
  });

  it("points at Completeness and cites the missing fields", () => {
    const msg = getScoreRecommendation(
      makeScore({
        overall: 65,
        specificity: { score: 32, max: 40 },
        structure: { score: 24, max: 30 },
        completeness: { score: 3, max: 30, missing: ["phone", "location"] },
      }),
    );
    expect(msg).toContain("phone and location");
    expect(msg).toMatch(/extract as plain text/i);
  });

  it("uses singular 'extracts' for a single missing field", () => {
    const msg = getScoreRecommendation(
      makeScore({
        completeness: { score: 3, max: 30, missing: ["email"] },
        specificity: { score: 36, max: 40 },
        structure: { score: 27, max: 30 },
      }),
    );
    expect(msg).toContain("check that email extracts as plain text");
  });

  it("surfaces the 4-digit-years guidance when dates are redacted", () => {
    const msg = getScoreRecommendation(
      makeScore({
        completeness: {
          score: 6,
          max: 30,
          missing: ["role dates"],
          redactedDates: true,
        },
        specificity: { score: 36, max: 40 },
        structure: { score: 27, max: 30 },
      }),
    );
    expect(msg).toMatch(/4-digit years/i);
    expect(msg).toMatch(/redaction stubs/i);
  });

  it("falls back when no dimension is gradable", () => {
    const msg = getScoreRecommendation(
      makeScore({
        overall: 30,
        specificity: { score: 0, max: 40, gradable: false },
        structure: { score: 0, max: 30, gradable: false },
        completeness: { score: 0, max: 30, gradable: false },
      }),
    );
    expect(msg).toMatch(/add a few quantified bullets/i);
    expect(msg).toContain("This has clear gaps to close");
  });

  it("uses the matching band opener for each tier", () => {
    const weakSpec = { specificity: { score: 8, max: 40 } };
    expect(
      getScoreRecommendation(makeScore({ overall: 85, ...weakSpec })),
    ).toContain("This is in solid shape");
    expect(
      getScoreRecommendation(makeScore({ overall: 65, ...weakSpec })),
    ).toContain("This is close");
    expect(
      getScoreRecommendation(makeScore({ overall: 40, ...weakSpec })),
    ).toContain("This has clear gaps to close");
  });

  it("keeps content-only messages free of parser/extractor language on the no-layout-flag path (issue #214)", () => {
    // Regression guard: earlier BAND_OPENER wording ("A generic extractor
    // struggles here" etc.) misattributed pure content weakness to a parser
    // failure — see #214. The layout-penalty branch of getScoreRecommendation
    // legitimately mentions parsers ("scramble it for many parsers"); this
    // test only exercises the content-only path (multiplier === 1, scanned
    // false, no triggers — all defaults from makeScore) and asserts the
    // returned sentence never mentions the parser or the extractor.
    //
    // Parametrized over every tier × every weakest-dimension path so a future
    // edit reintroducing "parser" vocabulary in any BAND_OPENER value OR any
    // dimensionStep() branch is caught on the same test.
    const weakestBy: Record<
      "specificity" | "structure" | "completeness",
      Parameters<typeof makeScore>[0]
    > = {
      specificity: {
        specificity: { score: 8, max: 40 },
        structure: { score: 27, max: 30 },
        completeness: { score: 27, max: 30, missing: [] },
      },
      structure: {
        specificity: { score: 36, max: 40 },
        structure: { score: 6, max: 30 },
        completeness: { score: 27, max: 30, missing: [] },
      },
      completeness: {
        specificity: { score: 36, max: 40 },
        structure: { score: 27, max: 30 },
        completeness: { score: 3, max: 30, missing: ["phone", "location"] },
      },
    };
    for (const overall of [85, 65, 40]) {
      for (const weakest of ["specificity", "structure", "completeness"] as const) {
        const msg = getScoreRecommendation(makeScore({ overall, ...weakestBy[weakest] }));
        expect(msg, `tier=${overall}, weakest=${weakest}`).not.toMatch(
          /parser|extractor/i,
        );
      }
    }
  });

  it("is deterministic — same input yields the same sentence", () => {
    const score = makeScore({ overall: 65, completeness: { score: 6, max: 30, missing: ["phone"] } });
    expect(getScoreRecommendation(score)).toBe(getScoreRecommendation(score));
  });
});

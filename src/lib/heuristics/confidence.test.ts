// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { computeConfidence, CANONICAL_CONFIDENCE_THRESHOLD } from "./confidence.ts";
import type { HeuristicResult, LayoutProbes } from "./types.ts";

function mkHeuristic(
  overrides: Partial<HeuristicResult["parsed"]> = {},
  fcOverrides: HeuristicResult["fieldConfidence"] = {},
): HeuristicResult {
  return {
    parsed: {
      full_name: "Alex Kim",
      // Free-domain email so the soft email-domain-mismatch check does not fire.
      email: "alex@gmail.com",
      skills: ["TypeScript"],
      skills_explicit: [],
      skills_inferred: [],
      experience: [
        {
          title: "Engineer",
          company: "Acme Inc.",
          start_date: "Jan 2022",
          is_current: true,
        },
      ],
      education: [
        { institution: "MIT", degree: "B.S.", year: "2020" },
      ],
      ...overrides,
    },
    fieldConfidence: {
      full_name: 0.9,
      email: 0.95,
      experience: 0.85,
      education: 0.8,
      skills: 0.7,
      ...fcOverrides,
    },
    // computeConfidence does not read sections; an empty view satisfies the
    // required field on HeuristicResult without affecting the result (#132).
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
  };
}

const cleanLayout: LayoutProbes = {
  isScanned: false,
  isTwoColumn: false,
  triggers: [],
};

describe("computeConfidence — happy path", () => {
  it("yields high confidence and suggestedEscalation=none for a clean parse", () => {
    const result = computeConfidence({
      heuristic: mkHeuristic(),
      layout: cleanLayout,
      rawCharCount: 800,
      extractedCharCount: 700,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(CANONICAL_CONFIDENCE_THRESHOLD);
    expect(result.suggestedEscalation).toBe("none");
  });
});

describe("computeConfidence — hard failures force escalation", () => {
  it("forces llm escalation when no email", () => {
    const h = mkHeuristic({ email: undefined }, { email: 0 });
    const result = computeConfidence({
      heuristic: h,
      layout: cleanLayout,
      rawCharCount: 800,
      extractedCharCount: 600,
    });
    expect(result.confidence).toBe(0);
    expect(["llm", "ocr", "ner"]).toContain(result.suggestedEscalation);
  });

  it("forces escalation when zero experience on non-student resume", () => {
    const h = mkHeuristic({ experience: [], education: [] });
    const result = computeConfidence({
      heuristic: h,
      layout: cleanLayout,
      rawCharCount: 400,
      extractedCharCount: 350,
    });
    expect(result.confidence).toBe(0);
  });

  it("tolerates zero experience on recent-graduate student resume", () => {
    const currentYear = new Date().getUTCFullYear();
    const h = mkHeuristic({
      experience: [],
      education: [
        { institution: "Berkeley", degree: "B.S.", year: String(currentYear - 1) },
      ],
    });
    const result = computeConfidence({
      heuristic: h,
      layout: cleanLayout,
      rawCharCount: 400,
      extractedCharCount: 350,
    });
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("forces ocr escalation on low extraction ratio", () => {
    const result = computeConfidence({
      heuristic: mkHeuristic(),
      layout: cleanLayout,
      rawCharCount: 5000,
      extractedCharCount: 100,
    });
    expect(result.confidence).toBe(0);
    expect(result.suggestedEscalation).toBe("ocr");
  });
});

describe("computeConfidence — layout triggers", () => {
  it("caps confidence on two-column layouts", () => {
    const result = computeConfidence({
      heuristic: mkHeuristic(),
      layout: { ...cleanLayout, isTwoColumn: true, triggers: ["two_column"] },
      rawCharCount: 800,
      extractedCharCount: 700,
    });
    expect(result.confidence).toBeLessThan(CANONICAL_CONFIDENCE_THRESHOLD);
    expect(result.suggestedEscalation).toBe("ner");
  });

  it("routes scanned PDFs to ocr regardless of field scores", () => {
    const result = computeConfidence({
      heuristic: mkHeuristic(),
      layout: { ...cleanLayout, isScanned: true, triggers: ["scanned"] },
      rawCharCount: 50,
      extractedCharCount: 40,
    });
    expect(result.confidence).toBe(0);
    expect(result.suggestedEscalation).toBe("ocr");
  });
});

describe("computeConfidence — soft penalties", () => {
  it("subtracts penalty for garbled bullets", () => {
    const h = mkHeuristic({
      experience: [
        {
          title: "Engineer",
          company: "Acme Inc.",
          start_date: "Jan 2022",
          is_current: true,
          description:
            "L e d a b i g p r o j e c t w i t h m a n y c o m p o n e n t s a n d t h i n g s",
        },
      ],
    });
    const clean = computeConfidence({
      heuristic: mkHeuristic(),
      layout: cleanLayout,
      rawCharCount: 800,
      extractedCharCount: 700,
    });
    const penalized = computeConfidence({
      heuristic: h,
      layout: cleanLayout,
      rawCharCount: 800,
      extractedCharCount: 700,
    });
    expect(penalized.confidence).toBeLessThan(clean.confidence);
  });
});

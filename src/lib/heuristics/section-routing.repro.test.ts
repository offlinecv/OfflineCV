// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Repro regressions for two section-routing parser bugs, reproduced from the
 * parser walkthrough and isolated to synthetic inputs (no PII, per the fixture
 * policy). Both assertions use `it.fails` — they encode the CORRECT behavior,
 * which the current parser does NOT yet satisfy, so they pass today as
 * documented-known-failures and will TRIP (turn red) the moment the bug is
 * fixed, forcing the fixer to flip them to a plain `it`.
 *
 *   #223 — coursework duplicated: `findSection` merges every section whose name
 *          resolves to `education`. "coursework" / "relevant coursework" are
 *          education aliases (sections.config.json), so a standalone coursework
 *          section's bullets are concatenated into the degree entry's
 *          `coursework[]`, duplicating coursework that also appears inline under
 *          the degree.
 *
 *   #225 — Certifications dropped: a "Certifications" heading IS recognized as a
 *          `certifications` PdfSection, but `buildHeuristicResult` in
 *          openresume.ts wires extractors only for summary / experience /
 *          education / skills / projects / achievements. No certifications
 *          extractor runs, so the section's content never reaches the structured
 *          parsed output.
 */

import { describe, it, expect } from "vitest";
import { parseHeuristic } from "./openresume.ts";
import { mkItems, mkDefaultPages } from "./__test-utils__/mkItem.ts";

function parse(
  lines: Array<{ text: string; fontSize?: number; page?: number; x?: number }>,
) {
  const items = mkItems(lines);
  return parseHeuristic(items, mkDefaultPages(items)).parsed;
}

describe("#223 — coursework must not duplicate across merged education sections", () => {
  // KNOWN FAILURE until #223 is fixed. When the section-merge dedupes
  // coursework, this starts passing and `it.fails` turns red — flip to `it`.
  it.fails(
    "does not repeat coursework when inline + a standalone Coursework section coexist",
    () => {
      const parsed = parse([
        { text: "Jane Doe", fontSize: 18 },
        { text: "jane.doe@example.com" },
        { text: "EDUCATION", fontSize: 14 },
        { text: "Stanford University" },
        { text: "B.S. Computer Science, 2018 - 2022" },
        { text: "● Algorithms" },
        { text: "● Databases" },
        { text: "RELEVANT COURSEWORK", fontSize: 14 },
        { text: "● Algorithms" },
        { text: "● Databases" },
      ]);
      const coursework = parsed.education[0]?.coursework ?? [];
      // Correct behavior: each distinct course appears once.
      expect(coursework).toEqual([...new Set(coursework)]);
    },
  );
});

describe("#225 — recognized Certifications section must not be dropped", () => {
  // KNOWN FAILURE until #225 is fixed. When a certifications extractor is wired
  // (or certs route to an extracted bucket), the content surfaces and this turns
  // red — flip to `it`.
  it.fails("surfaces Certifications content in the parsed output", () => {
    const parsed = parse([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane.doe@example.com" },
      { text: "CERTIFICATIONS", fontSize: 14 },
      { text: "AWS Certified Solutions Architect 2022" },
      { text: "Google Cloud Professional 2023" },
    ]);
    // Correct behavior: the recognized section's content lands SOMEWHERE in the
    // structured output rather than vanishing.
    expect(JSON.stringify(parsed)).toContain("AWS Certified Solutions Architect");
  });
});

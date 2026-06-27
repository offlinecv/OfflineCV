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
 *
 *   #225 — Honors/Awards collapsed: an Honors & Awards section whose items are
 *          grouped under sub-headings (International Awards / Domestic Awards /
 *          Community) and split by a page break collapses to a SINGLE
 *          `heuristic_achievements` entry — the first award line becomes the
 *          title and every later line is either dropped or mashed into one
 *          `description` blob, page footer included. Reproduced end-to-end from
 *          a real multi-page CV (subheadings + page-break footer are the
 *          trigger; a flat single-page Honors list parses fine, which is why
 *          earlier single-block repros missed it).
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

describe("#225 — Honors/Awards under sub-headings must not collapse to one entry", () => {
  // KNOWN FAILURE until the achievements extractor stops collapsing a
  // multi-subheading, page-split Honors section into a single entry. When each
  // award line survives (and the page footer is stripped), this turns red — flip
  // to a plain `it`.
  it.fails(
    "keeps every award line and drops the page-footer when Honors has sub-headings + a page break",
    () => {
      const parsed = parse([
        { text: "Jane Doe", fontSize: 18 },
        { text: "jane.doe@example.com" },
        { text: "HONORS & AWARDS", fontSize: 14 },
        { text: "International Awards", fontSize: 12 },
        { text: "2021 2nd Place, AWS AI/ML GameDay Online" },
        { text: "2020 Finalist, DEFCON 28 CTF World Final" },
        { text: "2018 Finalist, DEFCON 26 CTF World Final" },
        { text: "Domestic Awards", fontSize: 12 },
        { text: "June 10, 2026 Jane Doe Resume 2", page: 2 },
        { text: "2021 2nd Place, AWS Korea GameDay", page: 2 },
        { text: "2015 3rd Place, WITHCON Final", page: 2 },
      ]);
      const blob = JSON.stringify(parsed.heuristic_achievements ?? []);
      // Correct behavior: a later award line survives (not dropped or buried),
      // and the running-header/page-footer never contaminates an entry.
      expect(blob).toContain("DEFCON 28");
      expect(blob).not.toContain("Jane Doe Resume 2");
    },
  );
});

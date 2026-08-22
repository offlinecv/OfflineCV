// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Repro regressions for section-routing parser bugs, reproduced from the parser
 * walkthrough and isolated to synthetic inputs (no PII, per the fixture policy).
 * Each block was first landed as a documented-known-failure (`it.fails`)
 * encoding the CORRECT behavior the parser did not yet satisfy; once the fix
 * landed, the block was flipped to a plain `it` so it guards the fix going
 * forward. All three (#223, both #225 halves) are now fixed and assert as plain
 * `it`.
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
 *   #884 — Certifications FOLDED: #225's fix routed the section through the
 *          achievements extractor and then concatenated the two buckets, so a
 *          document that wrote two sections parsed to one. The assertions below
 *          pinned that fold — a merged bucket in document order — and now pin
 *          its reverse: two buckets, each with its own items, plus the
 *          document-order signal moved off the items and onto section placement.
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
  it(
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
  // FIXED (#225): `buildHeuristicResult` wires the recognized `certifications`
  // PdfSection through the achievements extractor, so the content surfaces in
  // the parsed output. Since #884 it surfaces in its OWN bucket.
  it("surfaces Certifications content in its own bucket", () => {
    const parsed = parse([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane.doe@example.com" },
      { text: "CERTIFICATIONS", fontSize: 14 },
      { text: "AWS Certified Solutions Architect 2022" },
      { text: "Google Cloud Professional 2023" },
    ]);
    const certTitles = (parsed.heuristic_certifications ?? []).map(
      (c) => c.title,
    );
    expect(certTitles.join(" | ")).toContain(
      "AWS Certified Solutions Architect",
    );
    // #884: a certifications-only résumé leaves the achievements bucket ABSENT.
    // Populating it is what made the export draw the literal heading
    // "Achievements" over a section the document called Certifications.
    expect(parsed.heuristic_achievements).toBeUndefined();
  });

  // #884, reversing #234: the two are separate buckets, so a résumé carrying
  // both keeps each section's items where the document put them — no
  // concatenation, in either order.
  it("keeps awards and certifications in separate buckets", () => {
    const parsed = parse([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane.doe@example.com" },
      { text: "AWARDS", fontSize: 14 },
      { text: "Best Paper Award 2021" },
      { text: "CERTIFICATIONS", fontSize: 14 },
      { text: "AWS Certified Solutions Architect 2022" },
    ]);
    expect((parsed.heuristic_achievements ?? []).map((a) => a.title)).toEqual([
      expect.stringContaining("Best Paper"),
    ]);
    expect((parsed.heuristic_certifications ?? []).map((c) => c.title)).toEqual([
      expect.stringContaining("AWS Certified"),
    ]);
    // Document order is achievements-first here, which is the default — so no
    // placement key is emitted and the parse stays byte-identical to a résumé
    // that never had the inversion.
    expect(parsed.certifications_placement).toBeUndefined();
  });

  // #234 review, retargeted by #884: the document-order signal survives, but as
  // SECTION PLACEMENT rather than item concatenation. A résumé that places
  // Certifications above Awards must still export certs-first.
  it("records certifications-above placement when Certifications precedes Awards", () => {
    const parsed = parse([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane.doe@example.com" },
      { text: "CERTIFICATIONS", fontSize: 14 },
      { text: "AWS Certified Solutions Architect 2022" },
      { text: "AWARDS", fontSize: 14 },
      { text: "Best Paper Award 2021" },
    ]);
    expect(parsed.certifications_placement).toBe("above_achievements");
    expect((parsed.heuristic_certifications ?? []).map((c) => c.title)).toEqual([
      expect.stringContaining("AWS Certified"),
    ]);
    expect((parsed.heuristic_achievements ?? []).map((a) => a.title)).toEqual([
      expect.stringContaining("Best Paper"),
    ]);
  });
});

describe("#225 — Honors/Awards under sub-headings must not collapse to one entry", () => {
  // FIXED (#225): a bullet-less achievements-family section is now parsed
  // one-entry-per-line, so each award survives a multi-subheading + page-break
  // layout, and the page running-header/footer line is stripped before parsing.
  it(
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

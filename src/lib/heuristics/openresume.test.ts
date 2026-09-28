// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { parseHeuristic } from "./openresume.ts";
import { mkItems, mkDefaultPages } from "./__test-utils__/mkItem.ts";

describe("parseHeuristic — clean single-column resume", () => {
  it("extracts name, contact, experience, education, skills with high confidence", () => {
    const items = mkItems([
      { text: "Jane Q. Doe", fontSize: 18 },
      { text: "jane.doe@example.com · (415) 555-0199 · San Francisco, CA", fontSize: 10 },
      { text: "https://linkedin.com/in/janedoe · github.com/janedoe", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp.                                   Jan 2022 – Present", fontSize: 11 },
      { text: "Senior Software Engineer", fontSize: 11 },
      { text: "• Led migration of payments service to Kotlin, cutting P95 by 40%.", fontSize: 10 },
      { text: "• Mentored 4 engineers; owned weekly design review cadence.", fontSize: 10 },
      { text: "" },
      { text: "Globex Inc.                                  Jun 2019 – Dec 2021", fontSize: 11 },
      { text: "Software Engineer", fontSize: 11 },
      { text: "• Shipped v2 of analytics pipeline handling 1B events/day.", fontSize: 10 },
      { text: "" },
      { text: "EDUCATION", fontSize: 13 },
      { text: "Stanford University — B.S. Computer Science — 2019", fontSize: 11 },
      { text: "" },
      { text: "SKILLS", fontSize: 13 },
      { text: "Kotlin, TypeScript, Go, Postgres, Kubernetes, AWS, React", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    expect(result.parsed.full_name).toBe("Jane Q. Doe");
    expect(result.parsed.email).toBe("jane.doe@example.com");
    expect(result.parsed.phone).toBeTruthy();
    expect(result.parsed.location).toContain("San Francisco");
    expect(result.parsed.linkedin_url).toContain("linkedin.com/in/janedoe");
    expect(result.parsed.github_url).toContain("github.com/janedoe");

    expect(result.parsed.experience.length).toBe(2);
    expect(result.parsed.experience[0].company).toContain("Acme");
    expect(result.parsed.experience[0].title).toBe("Senior Software Engineer");
    expect(result.parsed.experience[0].is_current).toBe(true);
    expect(result.parsed.experience[1].company).toContain("Globex");
    expect(result.parsed.experience[1].end_date).toContain("2021");

    expect(result.parsed.education.length).toBe(1);
    expect(result.parsed.education[0].institution).toContain("Stanford");
    expect(result.parsed.education[0].degree).toMatch(/B\.S\./);
    expect(result.parsed.education[0].year).toBe("2019");

    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Kotlin", "TypeScript", "Go", "React"]),
    );

    expect(result.fieldConfidence.full_name).toBeGreaterThan(0.7);
    expect(result.fieldConfidence.email).toBeGreaterThan(0.9);
    expect(result.fieldConfidence.experience).toBeGreaterThan(0.6);
    expect(result.fieldConfidence.education).toBeGreaterThan(0.6);
  });
});

describe("parseHeuristic — missing fields flag low confidence", () => {
  it("reports zero confidence on empty items", () => {
    const result = parseHeuristic([], []);
    expect(result.parsed.experience).toEqual([]);
    expect(result.parsed.education).toEqual([]);
    expect(result.parsed.skills).toEqual([]);
    expect(result.fieldConfidence.full_name ?? 0).toBe(0);
    expect(result.fieldConfidence.email ?? 0).toBe(0);
  });

  it("still parses name + contact even when experience section missing", () => {
    const items = mkItems([
      { text: "John Smith", fontSize: 18 },
      { text: "john@example.com", fontSize: 10 },
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed.full_name).toBe("John Smith");
    expect(result.parsed.email).toBe("john@example.com");
    expect(result.parsed.experience).toEqual([]);
  });
});

describe("parseHeuristic — two-column name-recovery fallback (issue #349)", () => {
  // Deedy-style two-column layout: the centred top-of-page name straddles the
  // column split, so column-ordered reading pushes it out of the profile band
  // (contact line stays; name gets flattened into a body section on the right).
  // The primary section-routed extractor misses it. The fallback re-scans the
  // top-of-page cluster from the un-column-reordered items and recovers the
  // name that the column reorder hid.
  it("recovers a centred top-of-page name that column-ordered flatten pushed out of profile", () => {
    // Left column at x=72 (Education), right column at x=320 (Experience). The
    // NAME sits at x=200 (centred, straddling the split) at the very top.
    const items = mkItems([
      { text: "Jane Smith", lineIndex: 0, x: 200, fontSize: 22 },
      { text: "jane.smith@example.com | (312) 555-0123", lineIndex: 1, x: 200, fontSize: 10 },
      // Left column: education
      { text: "EDUCATION", lineIndex: 2, x: 72, fontSize: 13 },
      { text: "CORNELL UNIVERSITY", lineIndex: 3, x: 72, fontSize: 12 },
      { text: "MEng in Computer Science", lineIndex: 4, x: 72, fontSize: 10 },
      // Right column: experience (same y range as left column education)
      { text: "EXPERIENCE", lineIndex: 2, x: 320, fontSize: 13 },
      { text: "FACEBOOK | Software Engineer", lineIndex: 3, x: 320, fontSize: 12 },
      { text: "Jan 2015 - Present", lineIndex: 4, x: 320, fontSize: 10 },
    ]);
    const boundaries = new Map<number, number>([[1, 250]]);
    const result = parseHeuristic(items, mkDefaultPages(items), [], boundaries);
    expect(result.parsed.full_name).toBe("Jane Smith");
    // Recovered from the alternate profile — same extractor, so confidence
    // must clear the score's contact-confidence floor.
    expect(result.fieldConfidence.full_name ?? 0).toBeGreaterThanOrEqual(0.5);
  });

  it("does not override a name the primary path already found", () => {
    // A single-column resume with a normal name-in-profile — the fallback is
    // gated on `singleColumn` so it never runs here; even if it did, the
    // primary result would win.
    const items = mkItems([
      { text: "Jane Q. Doe", fontSize: 18 },
      { text: "jane.doe@example.com", fontSize: 10 },
    ]);
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.parsed.full_name).toBe("Jane Q. Doe");
  });
});

describe("parseHeuristic — markdown-anchored section splitting", () => {
  // Reusable clean resume items. Over the 10–11pt body the 13pt headers clear
  // the emitter's promotion gate, and the 18pt name promotes as an H1 that
  // matches no canonical section.
  const cleanResumeItems = () =>
    mkItems([
      { text: "Jane Q. Doe", fontSize: 18 },
      { text: "jane.doe@example.com · (415) 555-0199", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp.                              Jan 2022 – Present", fontSize: 11 },
      { text: "Senior Software Engineer", fontSize: 11 },
      { text: "• Led payments migration.", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EDUCATION", fontSize: 13 },
      { text: "Stanford University — B.S. Computer Science — 2019", fontSize: 11 },
      { text: "", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      { text: "Kotlin, TypeScript, Go", fontSize: 10 },
    ]);

  const parseWithMarkdown = (items: ReturnType<typeof mkItems>) =>
    parseHeuristic(items, mkDefaultPages(items), [], undefined, {
      emitMarkdown: true,
    });

  it("records sectionSource='markdown' and carries the markdown when the emitter promotes canonical headings", () => {
    const result = parseWithMarkdown(cleanResumeItems());
    expect(result.sectionSource).toBe("markdown");
    expect(result.markdown).toMatch(/^#{1,3} EXPERIENCE$/m);
    expect(result.markdown).toMatch(/^#{1,3} EDUCATION$/m);
    expect(result.markdown).toMatch(/^#{1,3} SKILLS$/m);
    expect(result.parsed.experience.length).toBeGreaterThan(0);
    expect(result.parsed.education.length).toBe(1);
    expect(result.parsed.skills.length).toBeGreaterThan(0);
  });

  it("uses the regex splitter and emits no markdown when emission is off (the default)", () => {
    const items = cleanResumeItems();
    const result = parseHeuristic(items, mkDefaultPages(items));
    expect(result.sectionSource).toBe("regex");
    expect(result.markdown).toBeUndefined();
    expect(result.parsed.experience.length).toBeGreaterThan(0);
    expect(result.parsed.education.length).toBe(1);
  });

  it("falls back to regex when nothing clears the promotion gate (one font size throughout)", () => {
    const items = mkItems([
      { text: "Jane Q. Doe" },
      { text: "jane.doe@example.com" },
      { text: "EXPERIENCE" },
      { text: "Acme Corp. Jan 2022 – Present Senior Software Engineer" },
      { text: "• Led payments migration." },
      { text: "EDUCATION" },
      { text: "Stanford University — B.S. Computer Science — 2019" },
    ]);
    const result = parseWithMarkdown(items);
    expect(result.sectionSource).toBe("regex");
    // The emitter still ran — markdown is carried even when the splitter
    // declined it, so the LLM prompt keeps the structure-free rendering.
    expect(result.markdown).toBeDefined();
    expect(result.markdown).not.toMatch(/^#/m);
  });

  it("falls back to regex when fewer than two canonical headings are promoted", () => {
    const items = mkItems([
      { text: "Jane Q. Doe", fontSize: 18 },
      { text: "jane.doe@example.com", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp. Jan 2022 – Present", fontSize: 10 },
      { text: "Senior Software Engineer", fontSize: 10 },
      { text: "EDUCATION", fontSize: 10 },
      { text: "Stanford University — B.S. Computer Science — 2019", fontSize: 10 },
    ]);
    const result = parseWithMarkdown(items);
    expect(result.sectionSource).toBe("regex");
    expect(result.markdown).toMatch(/^#{1,3} EXPERIENCE$/m);
    expect(result.markdown).not.toMatch(/^#{1,3} EDUCATION$/m);
  });

  it("prevents a body-sized keyword line from becoming a false-positive section header", () => {
    // A resume where the word "Skills" appears in a summary paragraph at
    // body font size (not as a header). The regex-on-line splitter opens
    // a spurious Skills section at that line; the markdown-anchored
    // splitter rejects it because the emitter never promoted that line.
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "PROFILE", fontSize: 13 },
      // Body-sized prose line whose normalized text would match "skills".
      { text: "Skills", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp. Jan 2022 – Present", fontSize: 11 },
      { text: "Senior Software Engineer", fontSize: 11 },
      { text: "", fontSize: 10 },
      { text: "EDUCATION", fontSize: 13 },
      { text: "Stanford University — B.S. Computer Science — 2019", fontSize: 11 },
    ]);
    const result = parseWithMarkdown(items);
    expect(result.sectionSource).toBe("markdown");
    expect(result.markdown).not.toMatch(/^#{1,3} Skills$/m);
    // Experience survives because the Skills false-positive did not steal
    // the line that would have opened the real EXPERIENCE section in the
    // regex path (both paths get it right here — the assertion captures
    // the markdown path's independent correctness).
    expect(result.parsed.experience.length).toBe(1);
    expect(result.parsed.education.length).toBe(1);
  });

  // The #651 regression trio: heading rows the emitter's retired private
  // assembler rendered differently from the parser's lines, so the old
  // text-equality match failed and the whole document fell back to regex.
  // With one assembler and identity matching, each stays on the markdown path.
  describe("stays on the markdown path where the old private assembler disagreed (#651)", () => {
    const body = [
      { text: "Acme Corp. Jan 2022 – Present", fontSize: 10 },
      { text: "Senior Software Engineer", fontSize: 10 },
      { text: "• Led payments migration for the platform team.", fontSize: 10 },
      { text: "EDUCATION", fontSize: 13 },
      { text: "Stanford University — B.S. Computer Science — 2019", fontSize: 10 },
    ];

    it("a heading split across two same-baseline items that needs an inferred space", () => {
      // "WORK" + "EXPERIENCE" as two items with a gap: raw concatenation gave
      // "WORKEXPERIENCE", which is no section alias.
      const items = mkItems([
        { text: "Jane Q. Doe", lineIndex: 0, fontSize: 18 },
        { text: "jane.doe@example.com", lineIndex: 1, fontSize: 10 },
        { text: "WORK", lineIndex: 2, x: 72, fontSize: 13 },
        { text: "EXPERIENCE", lineIndex: 2, x: 101, fontSize: 13 },
        ...body.map((b, i) => ({ ...b, lineIndex: 3 + i })),
      ]);
      const result = parseWithMarkdown(items);
      expect(result.markdown).toMatch(/^#{1,3} WORK EXPERIENCE$/m);
      expect(result.sectionSource).toBe("markdown");
      expect(result.parsed.experience.length).toBe(1);
      expect(result.parsed.education.length).toBe(1);
    });

    it("a letter-spaced heading that only the shared assembler de-tracks", () => {
      // "S K I L L S" collapses to "SKILLS" in `mergeItemText`; the old
      // private grouper kept the spaces, and "s k i l l s" matches nothing.
      const items = mkItems([
        { text: "Jane Q. Doe", fontSize: 18 },
        { text: "jane.doe@example.com", fontSize: 10 },
        { text: "EXPERIENCE", fontSize: 13 },
        ...body.slice(0, 3),
        { text: "S K I L L S", fontSize: 13 },
        { text: "Kotlin, TypeScript, Go", fontSize: 10 },
      ]);
      const result = parseWithMarkdown(items);
      expect(result.markdown).toMatch(/^#{1,3} SKILLS$/m);
      expect(result.sectionSource).toBe("markdown");
      expect(result.parsed.skills).toEqual(
        expect.arrayContaining(["Kotlin", "TypeScript", "Go"]),
      );
    });

    it("a heading sharing its baseline with a far-right value the assembler cuts off", () => {
      // A body-size, non-date value >50pt to the right of the heading. The
      // shared assembler splits the row at the column gap so the heading line
      // reads "EXPERIENCE"; the old grouper welded it to "EXPERIENCEPython".
      // (A flush-right DATE is exempt from the cut — #425 — so it is not the
      // case this test guards.)
      const items = mkItems([
        { text: "Jane Q. Doe", lineIndex: 0, fontSize: 18 },
        { text: "jane.doe@example.com", lineIndex: 1, fontSize: 10 },
        { text: "EXPERIENCE", lineIndex: 2, x: 72, fontSize: 13 },
        { text: "Python", lineIndex: 2, x: 400, fontSize: 10 },
        ...body.map((b, i) => ({ ...b, lineIndex: 3 + i })),
      ]);
      const result = parseWithMarkdown(items);
      expect(result.markdown).toMatch(/^#{1,3} EXPERIENCE$/m);
      expect(result.sectionSource).toBe("markdown");
      expect(result.parsed.experience.length).toBe(1);
      expect(result.parsed.education.length).toBe(1);
    });
  });
});

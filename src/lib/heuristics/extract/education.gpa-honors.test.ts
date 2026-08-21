// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #883 — GPA and Latin honors reach the canonical résumé.
 *
 * Before this, both were discarded at Tier 1: the chunker recognised a
 * `GPA: …` line only well enough to stop it opening a phantom entry, and
 * nothing collected it, so the value never reached the reconstructed résumé,
 * the export, the JSON Resume attachment, or JD matching. Worse, an inline
 * note rode INTO the subject — `B.S. Computer Science · GPA 3.7` parsed to a
 * field of `"Computer Science · GPA 3.7"`.
 *
 * These assert the extractor's half. The recogniser's own vocabulary lives in
 * `education-grade.test.ts`; the export/re-parse half is pinned by the corpus
 * round-trip gate (which compares `gpa`/`honors` per entry) and by
 * `render-education-grade.repro.test.ts`.
 *
 * Synthetic personas only, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { extractEducation } from "./education.ts";
import { type PdfLine, type PdfSection } from "../sections.ts";

const mkLine = (text: string): PdfLine => ({
  page: 0,
  y: 0,
  x: 0,
  items: [],
  text,
  maxFontSize: 11,
  allCaps: false,
  gapAbove: 0,
});
const mkEduSection = (texts: string[]): PdfSection => ({
  name: "education",
  lines: texts.map(mkLine),
});

describe("extractEducation — GPA / honors on the degree line (#883)", () => {
  it("lifts both off the degree line and leaves the subject clean", () => {
    const { value } = extractEducation(
      mkEduSection([
        "The University of Texas at Dallas                                   May 2024",
        "B.S. in Computer Science, cum laude, GPA: 3.72/4.00",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    // The honors phrase used to survive the field cut, which anchored on
    // `[,;]\s*gpa` and so stopped at the GPA it could see, not at the first
    // annotation: the field came back as "Computer Science, cum laude".
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].gpa).toBe("3.72/4.00");
    expect(value[0].honors).toBe("cum laude");
  });

  it("keeps a middot-separated grade out of the subject", () => {
    const { value } = extractEducation(
      mkEduSection(["Springfield State University", "B.S. Computer Science · GPA 3.7"]),
    );
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].gpa).toBe("3.7");
  });

  it("keeps a trailing-label grade out of the subject", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Northwind University",
        "Bachelor of Science in Computer Science - 3.8 GPA",
      ]),
    );
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].gpa).toBe("3.8");
  });

  it("keeps the subject when the grade rides on with NO separator", () => {
    // The regression this file's other cases could not catch: every one of them
    // puts a comma or a middot in front of the note, so the segment split alone
    // separated subject from grade. With no separator the two are ONE segment,
    // and an unanchored labelled search called that whole segment a grade note —
    // for a LEAD segment the field cut drops the field entirely, so "Computer
    // Science" vanished from the parse, from the export, and from JD matching.
    const { value } = extractEducation(
      mkEduSection(["Northwind University", "B.S. in Computer Science GPA 3.8"]),
    );
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].gpa).toBe("3.8");
  });

  it("keeps BOTH halves of a two-part subject when the grade rides on with no separator", () => {
    // Same defect one segment further in: here the field cut reached the note
    // through `isEducationNoteSegment` instead, so only the trailing half of the
    // subject was lost. The field must come back exactly as it does without the
    // grade on the line.
    const { value } = extractEducation(
      mkEduSection([
        "Northwind University",
        "B.S. in Mathematics, Statistics GPA 3.8",
      ]),
    );
    expect(value[0].field).toBe("Mathematics, Statistics");
    expect(value[0].gpa).toBe("3.8");
  });

  it("keeps the subject when an unpunctuated grade is written label-last", () => {
    const { value } = extractEducation(
      mkEduSection(["Northwind University", "B.S. in Economics 3.8 GPA"]),
    );
    expect(value[0].field).toBe("Economics");
    expect(value[0].gpa).toBe("3.8");
  });

  it("does not mistake a two-part subject for a note", () => {
    const { value } = extractEducation(
      mkEduSection(["Northwind College", "B.A. Mathematics · Statistics, 2021"]),
    );
    expect(value[0].field).toBe("Mathematics · Statistics");
    expect(value[0].gpa).toBeUndefined();
  });
});

describe("extractEducation — GPA on a standalone annotation line (#883)", () => {
  it("captures it without splitting off a phantom entry", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Computer Science, 2017",
        "GPA: 3.9/4.0",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("Springfield State University");
    expect(value[0].gpa).toBe("3.9/4.0");
  });

  it("captures an honors line of its own", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Northwind University",
        "B.S. Computer Science, 2017",
        "Magna Cum Laude",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].honors).toBe("Magna Cum Laude");
  });

  it("attributes each annotation line to the entry it sits under", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Northwind University",
        "M.S. Data Science, 2022 - 2024",
        "GPA: 3.9",
        "Springfield State University",
        "B.S. Computer Science, 2018 - 2022",
        "GPA: 3.4",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value.map((e) => e.gpa)).toEqual(["3.9", "3.4"]);
  });

  it("keeps a note with its own entry when the NEXT line opens a degree", () => {
    // Degree-first ordering: the note is followed immediately by the next
    // entry's degree line, so the hint-less-entry lookahead reads the note
    // itself as the boundary. Pre-#883 that flushed the chunk AT the note,
    // handing the M.S.'s grade to the B.S. below it.
    const { value } = extractEducation(
      mkEduSection([
        "M.S. Data Science, 2024",
        "Northwind University",
        "GPA: 3.9",
        "B.S. Computer Science, 2022",
        "Springfield State University",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value.map((e) => e.degree)).toEqual(["M.S.", "B.S."]);
    expect(value.map((e) => e.gpa)).toEqual(["3.9", undefined]);
  });

  it("does the same for an unlabelled honors line, which has no prefix to match", () => {
    const { value } = extractEducation(
      mkEduSection([
        "M.S. Data Science, 2024",
        "Northwind University",
        "Magna Cum Laude",
        "B.S. Computer Science, 2022",
        "Springfield State University",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value.map((e) => e.honors)).toEqual(["Magna Cum Laude", undefined]);
  });

  it("does not read an honors phrase out of pooled body prose", () => {
    // A mis-routed compound header ("CERTIFICATIONS & ACTIVITIES") pools
    // sentences into the education section (#462/#467). "Graduated B.E. with
    // Distinction" is a sentence ABOUT a degree, not an honors annotation on
    // this entry — a substring search would claim it.
    const { value } = extractEducation(
      mkEduSection([
        "Ridgemont College",
        "B.E. in Computer Science, 2021",
        "Achievements: Graduated B.E. with Distinction; mentored 3 interns",
      ]),
    );
    expect(value[0].honors).toBeUndefined();
  });
});

describe("extractEducation — grade notations are preserved, never normalised (#883)", () => {
  const cases: [line: string, gpa: string][] = [
    ["B.Tech Computer Science, CGPA: 8.4/10", "8.4/10"],
    ["B.S. Computer Science, GPA: 3.9", "3.9"],
    ["B.A. Economics, First Class", "First Class"],
    ["B.A. Economics, 2:1", "2:1"],
    ["B.Com Accounting, GPA: 85%", "85%"],
  ];
  for (const [line, gpa] of cases) {
    it(`keeps ${JSON.stringify(gpa)} exactly as written`, () => {
      const { value } = extractEducation(
        mkEduSection(["Northwind University", line]),
      );
      expect(value[0].gpa).toBe(gpa);
      // The subject must not carry the grade text as well.
      expect(value[0].field ?? "").not.toMatch(/gpa|class|\d/i);
    });
  }
});

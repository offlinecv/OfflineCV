// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit coverage for the education grade / honors recogniser (#883).
 *
 * Three properties are asserted here rather than through the extractor, because
 * each is a claim about the PREDICATE and would be untestable once a chunk's
 * segmentation is in the way:
 *   - values survive VERBATIM, whatever notation and scale the résumé used;
 *   - an unlabelled honors or classification phrase matches only as a WHOLE
 *     segment, so ordinary prose containing "with distinction" is inert;
 *   - `formatGradeNote` is a genuine inverse of the recogniser — the round-trip
 *     the exporter depends on, pinned as a property over every shape below.
 *
 * Synthetic personas only, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import {
  classifyGradeSegment,
  cutTrailingGradeNote,
  formatGradeNote,
  isEducationNoteSegment,
  parseEducationGrade,
} from "./education-grade.ts";

/** Every grade NOTATION the recogniser claims to read, with the value it must
 *  yield — verbatim, including the source's own spacing around a scale. */
const GRADE_SHAPES: [line: string, gpa: string][] = [
  ["GPA: 3.72/4.00", "3.72/4.00"],
  ["GPA: 3.9/4.0", "3.9/4.0"],
  ["GPA 3.7", "3.7"],
  ["GPA: 3.9", "3.9"],
  ["GPA: 3.7 / 4.0", "3.7 / 4.0"],
  ["CGPA 8.4/10", "8.4/10"],
  ["SGPA: 9.1", "9.1"],
  ["Cumulative GPA: 3.93/4.0", "3.93/4.0"],
  ["Cum. GPA: 3.83 / 4.0", "3.83 / 4.0"],
  ["GPA: 85%", "85%"],
  ["GPA - 3.5", "3.5"],
  ["3.8 GPA", "3.8"],
  ["First Class", "First Class"],
  ["First Class Honours", "First Class Honours"],
  ["Second Class Upper Division", "Second Class Upper Division"],
  ["2:1", "2:1"],
  ["First Division", "First Division"],
];

describe("classifyGradeSegment — grade notations survive verbatim", () => {
  for (const [segment, gpa] of GRADE_SHAPES) {
    it(`reads ${JSON.stringify(segment)} as ${JSON.stringify(gpa)}`, () => {
      expect(classifyGradeSegment(segment)).toEqual({ kind: "gpa", value: gpa });
    });
  }

  it("declines a labelled grade that shares its segment with a subject", () => {
    // The LABELLED branch is whole-segment too, not just the unlabelled ones.
    // Its callers delete on a yes — the field cut drops the whole subject for a
    // lead segment — so an unanchored search here erased "Computer Science".
    expect(classifyGradeSegment("Computer Science GPA 3.8")).toBeUndefined();
    expect(classifyGradeSegment("Statistics GPA 3.8")).toBeUndefined();
    expect(classifyGradeSegment("Economics 3.8 GPA")).toBeUndefined();
    expect(isEducationNoteSegment("Computer Science GPA 3.8")).toBe(false);
  });

  it("still reads a qualified grade that IS the whole segment", () => {
    // The qualifier vocabulary is what keeps the anchoring above from rejecting
    // the real notes a résumé writes with a leading word.
    for (const seg of [
      "Cumulative GPA: 3.93/4.0",
      "Cum. GPA: 3.83 / 4.0",
      "Major GPA: 3.9 / 4.0",
      "Overall GPA 3.5",
    ]) {
      expect(classifyGradeSegment(seg)?.kind).toBe("gpa");
    }
  });

  it("never normalises a non-4.0 scale to a 4.0 one", () => {
    // The whole reason `gpa` is a string: 8.4/10 and 3.36/4.0 are the same
    // standing, and a float would erase which axis the résumé was on.
    expect(classifyGradeSegment("CGPA 8.4/10")?.value).toBe("8.4/10");
  });

  it("rejects a bare four-digit year that follows the keyword", () => {
    // Without the digit-boundary guard this surfaces "202" as a grade.
    expect(classifyGradeSegment("Best GPA 2020")).toBeUndefined();
  });

  it("rejects a grade keyword with no value after it", () => {
    expect(classifyGradeSegment("GPA")).toBeUndefined();
  });
});

describe("classifyGradeSegment — honors", () => {
  for (const phrase of [
    "cum laude",
    "Cum Laude",
    "magna cum laude",
    "Summa Cum Laude",
    "with honors",
    "with honours",
    "with distinction",
    "with highest honors",
  ]) {
    it(`reads ${JSON.stringify(phrase)} as honors`, () => {
      expect(classifyGradeSegment(phrase)).toEqual({
        kind: "honors",
        value: phrase,
      });
    });
  }

  it("strips an honors LABEL before matching the phrase", () => {
    expect(classifyGradeSegment("Honors: Magna Cum Laude")).toEqual({
      kind: "honors",
      value: "Magna Cum Laude",
    });
  });

  it("prefers the classification reading when a phrase is both", () => {
    // "First Class with Distinction" is ONE classification the résumé wrote —
    // splitting it across gpa and honors would store half in each.
    expect(classifyGradeSegment("First Class with Distinction")).toEqual({
      kind: "gpa",
      value: "First Class with Distinction",
    });
  });

  it("does NOT match an honors phrase buried in prose", () => {
    // The `compound-certifications-activities-tail` fixture pools exactly this
    // sentence into its education section. A substring search would read it as
    // honors on a real degree entry.
    expect(
      classifyGradeSegment("Achievements: Graduated B.E. with Distinction"),
    ).toBeUndefined();
    expect(
      classifyGradeSegment("Coursework included a summa cum laude seminar"),
    ).toBeUndefined();
  });
});

describe("parseEducationGrade", () => {
  it("takes the first grade in document order when several are listed", () => {
    // A cumulative GPA is written above a major GPA; the cumulative one is what
    // a reader means by "the GPA".
    expect(
      parseEducationGrade([
        "Magna Cum Laude",
        "Cum. GPA: 3.83 / 4.0",
        "Major GPA: 3.9 / 4.0",
      ]),
    ).toEqual({ gpa: "3.83 / 4.0", honors: "Magna Cum Laude" });
  });

  it("reads both off a single degree line", () => {
    expect(
      parseEducationGrade([
        "B.S. in Computer Science, cum laude, GPA: 3.72/4.00",
      ]),
    ).toEqual({ gpa: "3.72/4.00", honors: "cum laude" });
  });

  it("reaches a grade sitting behind a column gap", () => {
    expect(
      parseEducationGrade(["Bachelor of Arts, Business Administration\t  GPA:\t  3.5"]),
    ).toEqual({ gpa: "3.5" });
  });

  it("reaches a grade buried behind middots on a date/location line", () => {
    // The module docblock's own defended case, and the one anchoring the
    // segment predicate must not cost: the whole-LINE pass is unanchored, and
    // the middot split hands `classifyGradeSegment` a segment the label fills.
    expect(
      parseEducationGrade([
        "Aug. 2021 - May. 2025 · Columbus, Ohio · GPA: 3.7 / 4.0",
      ]),
    ).toEqual({ gpa: "3.7 / 4.0" });
  });

  it("still collects a grade that shares a segment with the subject", () => {
    // The whole-line pass is what makes the field cut safe to tighten: the
    // grade is still lifted onto the entry even though no SEGMENT is one.
    expect(parseEducationGrade(["B.S. in Computer Science GPA 3.8"])).toEqual({
      gpa: "3.8",
    });
  });

  it("returns nothing for an entry that carries neither", () => {
    expect(
      parseEducationGrade(["State University", "B.S. Computer Science, 2020"]),
    ).toEqual({});
  });
});

describe("formatGradeNote is the recogniser's inverse", () => {
  for (const [, gpa] of GRADE_SHAPES) {
    it(`re-reads ${JSON.stringify(gpa)} from its rendered note`, () => {
      expect(classifyGradeSegment(formatGradeNote(gpa))).toEqual({
        kind: "gpa",
        value: gpa,
      });
    });
  }

  it("labels a numeric value and leaves a classification bare", () => {
    expect(formatGradeNote("3.72/4.00")).toBe("GPA: 3.72/4.00");
    expect(formatGradeNote("First Class")).toBe("First Class");
  });
});

describe("cutTrailingGradeNote", () => {
  it("drops an unpunctuated trailing grade and keeps the subject", () => {
    expect(cutTrailingGradeNote("Computer Science GPA 3.8")).toBe(
      "Computer Science",
    );
    expect(cutTrailingGradeNote("Mathematics, Statistics GPA 3.8")).toBe(
      "Mathematics, Statistics",
    );
    expect(cutTrailingGradeNote("Economics 3.8 GPA")).toBe("Economics");
    expect(cutTrailingGradeNote("Physics Cum. GPA: 3.83 / 4.0")).toBe("Physics");
  });

  it("leaves a subject carrying no grade untouched", () => {
    expect(cutTrailingGradeNote("Computer Science")).toBe("Computer Science");
    expect(cutTrailingGradeNote("Mathematics, Statistics")).toBe(
      "Mathematics, Statistics",
    );
  });

  it("never empties a field that is nothing BUT a grade", () => {
    // That decision belongs to `classifyGradeSegment` and the field cut's lead
    // branch, which drop the field wholesale; emptying it here as well would
    // give two places the power to erase a field.
    expect(cutTrailingGradeNote("GPA 3.8")).toBe("GPA 3.8");
    expect(cutTrailingGradeNote("GPA: 3.72/4.00")).toBe("GPA: 3.72/4.00");
  });
});

describe("isEducationNoteSegment", () => {
  it("covers the minor / major / concentration labels the field cut always had", () => {
    expect(isEducationNoteSegment("Minor in Economics")).toBe(true);
    expect(isEducationNoteSegment("Concentration in Robotics")).toBe(true);
    expect(isEducationNoteSegment("CGPA 8.7/10")).toBe(true);
  });

  it("leaves a genuine subject alone", () => {
    expect(isEducationNoteSegment("Computer Science")).toBe(false);
    expect(isEducationNoteSegment("Statistics")).toBe(false);
  });

  it("recognizes an SGPA prefix on a malformed, valueless note the same as GPA/CGPA (review nit)", () => {
    // classifyGradeSegment finds no numeric value in any of these, so it's this
    // prefix fast path alone that has to catch them — and it must not treat
    // "sgpa" differently than the "gpa"/"cgpa" it already recognized, since
    // GRADE_LABEL_SRC ([cs]?gpa) treats all three as the same vocabulary.
    expect(isEducationNoteSegment("SGPA pending")).toBe(true);
    expect(isEducationNoteSegment("GPA pending")).toBe(true);
    expect(isEducationNoteSegment("CGPA pending")).toBe(true);
  });
});

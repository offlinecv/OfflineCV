// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression for the coursework continuation loop over-consuming the next
 * entry's content (#184). After a `Relevant Coursework` bullet, the recovery
 * loop must absorb at most one *wrapped* continuation line — never an acronym
 * school (`MIT`, `UC Berkeley`) in a School / Degree ordering, nor a trailing
 * prose note (`GPA: 3.8`, `Minor in Economics`). Genuine multi-column wraps
 * (`● Global Dimensions of` + `Business`) must still merge. Synthetic personas
 * only, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { extractEducation } from "../extract/education.ts";
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

describe("extractEducation — coursework loop must not over-consume (#184)", () => {
  it("does NOT swallow an acronym school after coursework into the prior course", () => {
    // School / Degree ordering: the prior entry ends in a coursework bullet,
    // then the NEXT entry leads with an acronym-only school. Pre-fix, `MIT`
    // got joined onto `Data Structures` and consumed, so the second entry lost
    // its institution.
    const { value } = extractEducation(
      mkEduSection([
        "Stanford University",
        "M.S. Computer Science, 2022 - 2024",
        "● Data Structures",
        "MIT",
        "B.S. Computer Science, 2018 - 2022",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value.map((e) => e.institution)).toEqual([
      "Stanford University",
      "MIT",
    ]);
    expect(value.map((e) => e.degree)).toEqual(["M.S.", "B.S."]);
    // The course title ends at the real course — `MIT` is not appended.
    expect(value[0].coursework).toEqual(["Data Structures"]);
  });

  it("does NOT absorb a trailing prose note (GPA / Minor) into the last course", () => {
    const { value } = extractEducation(
      mkEduSection([
        "San Jose State University",
        "B.S. Business Administration — May 2027",
        "● Financial Accounting",
        "● Microeconomics",
        "GPA: 3.8",
        "Minor in Economics",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].coursework).toEqual([
      "Financial Accounting",
      "Microeconomics",
    ]);
  });

  it("attributes coursework to its own degree across multiple entries (#190)", () => {
    // Two degrees, each with its OWN coursework bullet. Pre-fix, both lines
    // pooled onto entry[0] and entry[1] got none.
    const { value } = extractEducation(
      mkEduSection([
        "Lakeside Institute of Technology",
        "M.S. Computer Science, 2022 - 2024",
        "● Incoming Courses: Deep Learning, Machine Learning",
        "Northgate State University",
        "B.S. Computer Science, 2018 - 2022",
        "● Relevant Coursework: Data Structures, Algorithms",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0].institution).toBe("Lakeside Institute of Technology");
    expect(value[0].coursework).toEqual([
      "Incoming Courses: Deep Learning, Machine Learning",
    ]);
    expect(value[1].institution).toBe("Northgate State University");
    expect(value[1].coursework).toEqual([
      "Relevant Coursework: Data Structures, Algorithms",
    ]);
  });

  it("still merges a genuine wrapped coursework cell (regression guard)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "San Jose State University",
        "B.S. Business Administration — May 2027",
        "● Global Dimensions of",
        "Business",
        "● Legal Environment of",
        "Business",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("San Jose State University");
    expect(value[0].coursework).toEqual([
      "Global Dimensions of Business",
      "Legal Environment of Business",
    ]);
  });
});

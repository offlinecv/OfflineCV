// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression for #556 — a GPA/CGPA note appended to the institution string with
 * no comma boundary was left glued to the school name:
 *
 *   Master of Science Information Technology, Northwind University GPA 3.8
 *
 * `stripInstitutionDate` only peels trailing dates, and `cleanField`'s GPA cut
 * runs on the degree *field* and only after a `,`/`;`. Nothing removed a
 * space-separated `GPA <n.nn>` tail from the institution. A dedicated
 * `stripInstitutionGrade` now peels it.
 *
 * Synthetic personas only, per the fixtures PII policy.
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

const instOf = (line: string) =>
  extractEducation(mkEduSection([line])).value[0]?.institution;

describe("extractEducation — GPA glued to institution (#556)", () => {
  it("strips a space-separated GPA tail", () => {
    expect(
      instOf("Master of Science Information Technology, Northwind University GPA 3.8"),
    ).toBe("Northwind University");
  });

  it("strips a colon / slash-scale CGPA tail", () => {
    expect(instOf("B.Tech Computer Science, Northwind Institute of Tech CGPA 8.7/10")).toBe(
      "Northwind Institute of Tech",
    );
  });

  it("strips a comma-delimited GPA tail", () => {
    expect(instOf("B.S. Biology, Northwind College, GPA: 3.8")).toBe("Northwind College");
  });

  it("does not cut a school name that merely ends in a digit", () => {
    expect(instOf("B.A. History, Route 66 University")).toBe("Route 66 University");
  });
});

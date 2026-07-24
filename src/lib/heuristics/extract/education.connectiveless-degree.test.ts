// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression for #557 — a connective-less degree name ("<prefix> of <Type>
 * <Field>" with no " in ") mis-partitioned into degree/field:
 *
 *   Master of Science Information Technology        → field lost entirely
 *   Bachelor of Technology Electronics & Comm. Eng. → split mid-phrase
 *
 * `DEGREE_RE`'s greedy `of <subject>` branch swallowed the field into the
 * credential. `DEGREE_TYPE_RE` now cuts the credential at the end of the
 * degree-TYPE word so the field survives, while a type-only credential
 * ("Master of Business Administration") is left whole and the US " in "
 * connective form is untouched.
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

const parse1 = (line: string) => extractEducation(mkEduSection([line])).value[0];

describe("extractEducation — connective-less 'of <Type> <Field>' degree (#557)", () => {
  it("splits 'Master of Science Information Technology'", () => {
    const e = parse1("Master of Science Information Technology, Northwind University");
    expect(e.degree).toBe("Master of Science");
    expect(e.field).toBe("Information Technology");
  });

  it("splits 'Bachelor of Technology Electronics & Communication Eng.' without losing the ampersand", () => {
    const e = parse1(
      "Bachelor of Technology Electronics & Communication Eng., Northwind Institute of Tech",
    );
    expect(e.degree).toBe("Bachelor of Technology");
    expect(e.field).toBe("Electronics & Communication Eng.");
  });

  it("leaves a type-only credential whole (no field to cut)", () => {
    const e = parse1("Master of Business Administration, Northwind University");
    expect(e.degree).toBe("Master of Business Administration");
    expect(e.field ?? "").toBe("");
  });

  it("does not regress the ' in ' connective form", () => {
    const e = parse1("Bachelor of Science in Biology, Northwind University");
    expect(e.degree).toBe("Bachelor of Science");
    expect(e.field).toBe("Biology");
  });
});

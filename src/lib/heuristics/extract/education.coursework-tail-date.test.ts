// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression for #555 — an education entry's attendance date is dropped when
 * the date range sits at the TAIL of a coursework line rather than on the
 * degree/institution line:
 *
 *   Master of Science Information Technology, Northwind University
 *   Coursework: Advanced Databases, Data Analytics, Data Mining. Aug 2023 – May 2025
 *
 * `filterAnnotationLinesForDates` drops the whole coursework line before date
 * parsing (it matches the "coursework" annotation keyword and carries no degree
 * token), taking the trailing `Aug 2023 – May 2025` with it — the entry came
 * back with no dates. The fix peels that trailing date off inside the coursework
 * collector (so it is not surfaced as a phantom course) and re-attributes it via
 * `courseworkDates` — but ONLY when the target entry parsed no date of its own.
 *
 * That guard is the whole point, and the third test pins it: recovering the tail
 * date through the whole-chunk `filterAnnotationLinesForDates` path instead would
 * reopen the #371 over-capture class, because `parseDateRange` prefers a range
 * over a bare year and the chunk path has no way to express "only when the entry
 * is dateless".
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

describe("extractEducation — attendance date at the coursework-line tail (#555)", () => {
  it("recovers the range from the coursework tail and keeps it out of the course list", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Master of Science Information Technology, Northwind University",
        "Coursework: Advanced Databases, Data Analytics, Data Mining. Aug 2023 – May 2025",
      ]),
    );
    expect(value.length).toBe(1);
    const edu = value[0];
    expect(edu.start_date).toBeTruthy();
    expect(edu.end_date).toBeTruthy();
    expect(edu.year).toBe("2025");
    // The date must not leak into the coursework items.
    const courses = edu.coursework ?? [];
    expect(courses).toContain("Data Mining");
    expect(courses.join(" ")).not.toMatch(/2023|2025|Aug|May/);
  });

  it("still drops a dateless annotation line and does not over-capture a sibling's year (#371)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science, Some University, 2017",
        "GPA: 3.7 · Dean's List 2013 - 2015",
      ]),
    );
    expect(value.length).toBe(1);
    // The real graduation year wins; the Dean's-List range must not override it.
    expect(value[0].year).toBe("2017");
  });

  it("does not let a MONTH-YEAR annotation range override a sibling's graduation year (#371)", () => {
    // The year-only sibling above ("Dean's List 2013 - 2015") is dropped by
    // `parseDateRange`'s bare-year start; a month-year-precision annotation range
    // is the shape that would survive a tail-date carve-out on the whole-chunk
    // path and silently beat the real single-year graduation date. Pinned here so
    // the #555 recovery can never be re-plumbed through that path.
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science, Some University, 2017",
        "Awards: Best Thesis, Sep 2019 - Jun 2020",
      ]),
    );
    expect(value.length).toBe(1);
    expect(value[0].year).toBe("2017");
    expect(value[0].start_date).toBeUndefined();
  });
});

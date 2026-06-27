// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression tests for page-2 entry loss (#219).
 *
 * On a 2-page resume the page break is incidental; the structural triggers are:
 *
 *   1. EXPERIENCE — a trailing role whose header carries NO `MM/YYYY - MM/YYYY`
 *      date range (e.g. "Early Career: IC & Consultant"). Date-range anchoring
 *      used to be REQUIRED to open an entry, so the dateless block folded into
 *      the previous role's body and was lost. It must now emit as its own entry
 *      with empty date fields — WITHOUT splitting a wrapped bullet tail off as a
 *      phantom role.
 *
 *   2. EDUCATION — two schools where only one carries a year. A second school
 *      whose program name has no degree/institution keyword but carries its own
 *      inline graduation year ("MIT Applied Data Science (2023)") used to merge
 *      into the first chunk, dropping the second entry AND bleeding its year
 *      onto the first (yearless) school. The year must stay with its own entry.
 *
 * Synthetic personas only, per the fixtures PII policy. Driven directly against
 * the entry-segmentation functions, so this fixture is PII-free by construction.
 */

import { describe, it, expect } from "vitest";
import { extractExperience } from "./experience.ts";
import { extractEducation } from "./education.ts";
import { type PdfLine, type PdfSection } from "../sections.ts";

const mkLine = (text: string, x = 0, y = 0): PdfLine => ({
  page: 0,
  y,
  x,
  items: [],
  text,
  maxFontSize: 11,
  allCaps: false,
  gapAbove: 0,
});
const mkSection = (
  name: PdfSection["name"],
  rows: Array<[string, number, number]> | string[],
): PdfSection => ({
  name,
  lines: rows.map((r) => (Array.isArray(r) ? mkLine(r[0], r[1], r[2]) : mkLine(r))),
});

describe("dateless trailing experience role (#219)", () => {
  it("emits a dateless trailing role (header + bullets) with empty dates", () => {
    const { value } = extractExperience(
      mkSection("experience", [
        ["Senior Engineer", 0, 100],
        ["Northwind Labs   01/2020 - 12/2022", 0, 90],
        ["• Built scalable services", 10, 80],
        ["• Led a team of 5", 10, 70],
        ["Early Career: IC & Consultant", 0, 50],
        ["Acme Co", 0, 40],
        ["• Consulted on data pipelines", 10, 30],
        ["• Shipped ETL jobs", 10, 20],
      ]),
    );
    expect(value).toHaveLength(2);
    // The dated role keeps only its own two bullets — the dateless block no
    // longer contaminates its description.
    expect(value[0]).toMatchObject({
      title: "Senior Engineer",
      company: "Northwind Labs",
      start_date: "01/2020",
      end_date: "12/2022",
    });
    expect(value[0].description).toBe(
      "Built scalable services\nLed a team of 5",
    );
    // The dateless role emits with empty date fields and its own bullets.
    expect(value[1]).toMatchObject({
      title: "Early Career: IC & Consultant",
      company: "Acme Co",
    });
    expect(value[1].start_date).toBeUndefined();
    expect(value[1].end_date).toBeUndefined();
    expect(value[1].description).toBe(
      "Consulted on data pipelines\nShipped ETL jobs",
    );
  });

  it("does NOT split a wrapped, lowercase-led bullet tail into a phantom role", () => {
    // The previous role's last bullet wraps onto a marker-less continuation line
    // ("infrastructure cost by 28%.") that sits between two bullets. A loose
    // dateless-anchor rule would split it off as an empty-title phantom role.
    const { value } = extractExperience(
      mkSection("experience", [
        ["Senior Software Engineer", 0, 100],
        ["Acme Corp   Jan 2022 - Present", 0, 90],
        ["• Cut p99 latency by 42% and", 10, 80],
        ["infrastructure cost by 28%.", 14, 73],
        ["• Owned the payments service", 10, 65],
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].title).toBe("Senior Software Engineer");
  });

  it("returns no entries for a section with bullets but zero dated anchors", () => {
    // The "no date range ⇒ []" contract for the date_range anchor still holds:
    // a fully dateless section routes through the first_line anchor elsewhere,
    // not through experience's date_range path.
    const { value } = extractExperience(
      mkSection("experience", [
        ["Volunteer Lead", 0, 100],
        ["• Organized weekend events", 10, 90],
      ]),
    );
    expect(value).toHaveLength(0);
  });
});

describe("education year mis-attribution across entries (#219)", () => {
  it("keeps an inline-dated second program separate; no year bleed", () => {
    const { value } = extractEducation(
      mkSection("education", [
        "Stanford University",
        "B.S. Computer Science",
        "MIT Applied Data Science (2023)",
      ]),
    );
    expect(value).toHaveLength(2);
    const stanford = value.find((e) => e.institution.includes("Stanford"));
    const mit = value.find((e) => e.institution.includes("MIT"));
    // The year belongs only to the entry it appears under.
    expect(stanford?.year).toBeUndefined();
    expect(mit?.year).toBe("2023");
  });

  it("does not split a school's own graduation-date line into a phantom entry", () => {
    // "Grad. May 2011 | Kolkata, India" is the DATE line of the school above it,
    // not a new program — the inline-dated-program split must NOT fire on a
    // graduation-date/location line, so no phantom "Grad …" entry appears and
    // the year stays with the real school.
    const { value } = extractEducation(
      mkSection("education", [
        "Cornell University",
        "B.S. Computer Science, May 2014",
        "GPA: 3.8",
        "La Martiniere For Boys",
        "Grad. May 2011 | Kolkata, India",
      ]),
    );
    // No entry is the spurious graduation-date line: the inline-dated-program
    // split must not fire on a "Grad. … | City, Country" date/location line.
    expect(
      value.some((e) => /^grad\b/i.test(e.institution.trim())),
    ).toBe(false);
    // And the trailing 2011 grad year does not bleed onto the real degree above
    // it — Cornell keeps its own 2014, never 2011.
    const cornell = value.find((e) => e.institution.includes("Cornell"));
    expect(cornell?.year).toBe("2014");
  });
});

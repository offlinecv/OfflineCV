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

  it("does NOT split a CAPITAL-led wrapped bullet tail when geometry is degenerate (x=0 DOCX)", () => {
    // DOCX→PDF conversions collapse every glyph to x=0, so the indent-based
    // wrapped-continuation filter is a no-op and a short, Title-case wrap tail
    // ("Senior Leadership on strategic planning") slips past the prose/capital
    // gates. The predecessor bullet ends on a dangling conjunction ("…and"),
    // which is the decisive signal that this line is its wrap, not a new header.
    const { value } = extractExperience(
      mkSection("experience", [
        ["Acme Corp — Senior Engineer", 0, 100],
        ["Jan 2020 - Mar 2023", 0, 90],
        ["• Collaborated with the Board of Directors and", 0, 80],
        ["Senior Leadership on strategic planning", 0, 70],
        ["• Reduced cloud spend by 30%", 0, 60],
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].title).toBe("Senior Engineer");
    expect(value[0].company).toBe("Acme Corp");
    // The wrap tail stays inside the role body — not promoted to a phantom role.
    expect(value[0].description).toContain("Senior Leadership on strategic planning");
    expect(value[0].description).toContain("Reduced cloud spend by 30%");
  });

  it("opens a single-line mid-dot dateless trailing role as its own entry (#239)", () => {
    // #239's exact shape: a trailing role whose ONE-LINE header carries the org
    // inline (`Title · Org, Location`) but no date range, after a dated role
    // whose header puts everything on one line. Pre-fix the dateless header and
    // its bullets were absorbed into the AOL/Netscape role's description (6 of 7
    // roles parsed); it must now open its own entry with empty dates.
    const { value } = extractExperience(
      mkSection("experience", [
        [
          "Sr. Software Engineer · America Online / Netscape, MV, CA            07/2004 - 11/2006",
          0,
          100,
        ],
        ["• Architected the foundational accessibility layer for Boxely UI", 10, 90],
        [
          "Early Career: IC & Consultant · Microsoft, Aksharamala, Siemens ICN, HCL R&D, E-Z Data",
          0,
          70,
        ],
        ["• Pioneered Indian-language input on Windows through Aksharamala", 10, 60],
        ["• Developed an innovative point-and-click tool", 10, 50],
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0]).toMatchObject({
      title: "Sr. Software Engineer",
      company: "America Online / Netscape",
      start_date: "07/2004",
      end_date: "11/2006",
    });
    // The dateless role opens its own entry with its two bullets and no dates.
    expect(value[1].title).toBe("Early Career: IC & Consultant");
    expect(value[1].start_date).toBeUndefined();
    expect(value[1].end_date).toBeUndefined();
    expect(value[1].description).toBe(
      "Pioneered Indian-language input on Windows through Aksharamala\nDeveloped an innovative point-and-click tool",
    );
  });

  it("opens a dateless role whose predecessor bullet WRAPPED onto a continuation line (#239)", () => {
    // The previous role's last bullet wraps onto a marker-less continuation line
    // ("millions of users…") that ends on a period — so the dateless header sits
    // below that wrap, not below the bullet marker. The new-entry boundary must
    // still fire: a header following a wrapped-bullet body still closes the prior
    // role. (A loose rule must NOT split the wrap itself off — it's lowercase-led
    // prose indented past the marker, caught by the geometry + shape gates.)
    const { value } = extractExperience(
      mkSection("experience", [
        [
          "Sr. Software Engineer · America Online / Netscape, MV, CA   07/2004 - 11/2006",
          0,
          100,
        ],
        [
          "• Architected the foundational accessibility layer for AOL's Boxely UI used by",
          10,
          90,
        ],
        ["millions of users across the product suite.", 14, 83],
        [
          "Early Career: IC & Consultant · Microsoft, Aksharamala, Siemens ICN, HCL R&D",
          0,
          70,
        ],
        ["• Pioneered Indian-language input on Windows through Aksharamala", 10, 60],
        ["• Developed an innovative point-and-click tool", 10, 50],
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0].title).toBe("Sr. Software Engineer");
    // The wrap stays inside the prior role's body — not promoted to a phantom.
    expect(value[0].description).toContain("millions of users across the product suite.");
    expect(value[1].title).toBe("Early Career: IC & Consultant");
    expect(value[1].description).toBe(
      "Pioneered Indian-language input on Windows through Aksharamala\nDeveloped an innovative point-and-click tool",
    );
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

  it.each([
    ["Dean's List 2020, 2021, 2022"],
    ["Awards and Honors 2023"],
    ["Honors Thesis: AI Systems (2024)"],
    ["Teaching Assistant for Web (2022 - 2023)"],
    ["Study Abroad, Florence 2021"],
  ])(
    "does not split an in-chunk honors/awards annotation with an inline year into a phantom entry: %s",
    (annotation) => {
      // An honors/awards/activity line that happens to carry a year is a
      // sub-field of the school above it, NOT a second program. The
      // inline-dated-program split must not fire on it (it would create a
      // degree-less phantom education entry whose institution is the annotation).
      const { value } = extractEducation(
        mkSection("education", [
          "Bachelor of Science in Computer Science",
          "Stanford University",
          "Sep 2018 - Jun 2022",
          annotation,
        ]),
      );
      expect(value).toHaveLength(1);
      expect(value[0].institution).toContain("Stanford");
    },
  );
});

describe("degree-less program entry dropped + year orphaned (#238)", () => {
  // The issue's exact reproducer: a program/certificate entry whose first line is
  // a program TITLE with an inline year (no degree keyword) followed by its own
  // institution line, sitting ABOVE a normal degree entry that has NO date of its
  // own. Pre-fix, the program entry was dropped (it lacked the degree keyword the
  // chunker anchored on) and its 2023 leaked onto the JNTU degree below it.
  it("keeps the degree-less program entry AND binds its year to itself, not the next entry", () => {
    const { value } = extractEducation(
      mkSection("education", [
        "Applied Data Science Program: Leveraging AI for Effective Decision-Making        2023",
        "MIT Professional Education",
        "Bachelor of Technology in Computer Science & Engineering",
        "JNTU College Of Engineering, Hyderabad",
      ]),
    );
    // Both entries survive — the program entry is no longer dropped.
    expect(value).toHaveLength(2);

    const mit = value.find((e) => e.institution.includes("MIT"));
    const jntu = value.find((e) => e.institution.includes("JNTU"));
    expect(mit).toBeDefined();
    expect(jntu).toBeDefined();

    // The program entry: institution is its OWN school, the program title lands in
    // `field` (no credential keyword), and the inline 2023 stays with it.
    expect(mit?.institution).toBe("MIT Professional Education");
    expect(mit?.degree).toBe("");
    expect(mit?.field).toContain("Applied Data Science Program");
    expect(mit?.year).toBe("2023");

    // The JNTU degree keeps its own degree/field and — crucially (C2) — does NOT
    // inherit the program's 2023; it genuinely has no date.
    expect(jntu?.degree).toBe("Bachelor of Technology");
    expect(jntu?.field).toBe("Computer Science & Engineering");
    expect(jntu?.year).toBeUndefined();
  });

  it("works regardless of order — program entry BELOW the dated-less degree entry", () => {
    const { value } = extractEducation(
      mkSection("education", [
        "Bachelor of Technology in Computer Science & Engineering",
        "JNTU College Of Engineering, Hyderabad",
        "Applied Data Science Program: Leveraging AI for Effective Decision-Making        2023",
        "MIT Professional Education",
      ]),
    );
    expect(value).toHaveLength(2);
    const mit = value.find((e) => e.institution.includes("MIT"));
    const jntu = value.find((e) => e.institution.includes("JNTU"));
    expect(mit?.year).toBe("2023");
    expect(mit?.field).toContain("Applied Data Science Program");
    expect(jntu?.year).toBeUndefined();
  });
});

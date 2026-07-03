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
import { extractEducation, splitDoubledCity } from "../extract/education.ts";
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

describe("extractEducation — capstone/project sub-line stays annotation, not sibling entry (#251)", () => {
  it("does NOT split a capstone project sub-line into a phantom education entry", () => {
    // A line like "Capstone Project: Real-time Sentiment Analysis (2023)" sits
    // under a degree and must remain an annotation, not become a second entry.
    const { value } = extractEducation(
      mkEduSection([
        "University of Example",
        "B.S. Computer Science   2020 - 2024",
        "Capstone Project: Real-time Sentiment Analysis (2023)",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("University of Example");
    expect(value[0].degree).toBe("B.S.");
  });

  it("does NOT split a 'Senior Project' sub-line into a phantom education entry", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Lakeside Institute of Technology",
        "Bachelor of Science in Electrical Engineering   2019 - 2023",
        "Senior Project: Autonomous Drone Navigation (2023)",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("Lakeside Institute of Technology");
  });

  it("still recognizes a genuine program entry that carries no capstone/project keyword", () => {
    // "Applied Data Science Program" carries no denylist word, so a genuine
    // certificate/program entry on its own line must still be recognized.
    const { value } = extractEducation(
      mkEduSection([
        "Massachusetts Institute of Technology",
        "B.S. Computer Science   2018 - 2022",
        "Applied Data Science (2023)",
      ]),
    );
    // The inline-dated program "Applied Data Science (2023)" should produce a
    // second entry since it carries no denylist keyword and has a year.
    expect(value).toHaveLength(2);
    expect(value[0].institution).toBe("Massachusetts Institute of Technology");
  });

  it("still splits a credential title that merely contains the word 'project'", () => {
    // "Project Management Certificate" is a genuine standalone credential, not an
    // annotation — the denylist must not swallow it just because it contains
    // "project" (bare-word breadth was a #251 adversarial-review blocking finding).
    const { value } = extractEducation(
      mkEduSection([
        "Cornell University",
        "B.S. Information Science   2017 - 2021",
        "Project Management Certificate 2022",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0].institution).toBe("Cornell University");
  });
});

describe("extractEducation — degree/field split + location peel (#222)", () => {
  it("splits 'B.S. in Computer Science' into bare degree + field and peels City, ST", () => {
    // The issue's exact reproducer: degree+field+dates on the second line,
    // institution+location on the first (column gap before the city).
    const { value } = extractEducation(
      mkEduSection([
        "University of Example, Allen School of CS and Engineering   Seattle, WA",
        "B.S. in Computer Science   Sep. 2024 - Jun. 2027",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].institution).toBe(
      "University of Example, Allen School of CS and Engineering",
    );
    expect(value[0].location).toBe("Seattle, WA");
  });

  it("keeps an ampersand subject when DEGREE_RE's 'of' branch swallows the 'in' tail", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Indian Institute of Technology",
        "Bachelor of Technology in Computer Science & Engineering, 2018 - 2022",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("Bachelor of Technology");
    expect(value[0].field).toBe("Computer Science & Engineering");
  });

  it("recovers a connective-less '<credential> <Field>' subject without the trailing date", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Stanford University",
        "M.S. Computer Science, 2022 - 2024",
      ]),
    );
    expect(value[0].degree).toBe("M.S.");
    expect(value[0].field).toBe("Computer Science");
  });

  it("peels an international 'City, Country' off the institution", () => {
    const { value } = extractEducation(
      mkEduSection([
        "University of Example, London, United Kingdom",
        "M.S. in Data Science   2021",
      ]),
    );
    expect(value[0].institution).toBe("University of Example");
    expect(value[0].location).toBe("London, United Kingdom");
    expect(value[0].field).toBe("Data Science");
  });

  it("leaves field/location absent when the degree line carries neither", () => {
    const { value } = extractEducation(
      mkEduSection(["Massachusetts Institute of Technology", "Bachelor of Science, 2020"]),
    );
    expect(value[0].degree).toBe("Bachelor of Science");
    expect(value[0].field).toBeUndefined();
    expect(value[0].location).toBeUndefined();
  });

  it("does not split a state-only 'Institution, ST' (no city) at a normal word space", () => {
    // A single space inside the institution name must not be read as a city
    // boundary — only a 2+ space column gap separates a city. #222 follow-up.
    const { value } = extractEducation(
      mkEduSection(["Stanford University, CA", "M.S. in Statistics   2021 - 2023"]),
    );
    expect(value[0].institution).toBe("Stanford University, CA");
    expect(value[0].location).toBeUndefined();
  });

  it("parses an 'M.Sc.' credential without stranding 'c.' into the field", () => {
    // DEGREE_RE must prefer the longer 'M.Sc.' over 'M.S.' so the credential
    // isn't truncated to 'M.S' with 'c. in Data Science' bleeding into field.
    const { value } = extractEducation(
      mkEduSection(["University of Example", "M.Sc. in Data Science, 2021 - 2023"]),
    );
    expect(value[0].degree).toBe("M.Sc.");
    expect(value[0].field).toBe("Data Science");
  });
});

describe("extractEducation — trailing date peeled cleanly off one-line institution (#294)", () => {
  // The reconstructed-résumé sub-line emits "Institution  Dates" on one line.
  // `stripInstitutionDate` must peel the WHOLE date, not just its trailing year —
  // a half-strip ("… Fall 2013 – Spring") corrupts the institution field.
  it("peels a season-qualified range whole (not just the trailing year)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science",
        "Some University  Fall 2013 – Spring 2014",
      ]),
    );
    expect(value[0].institution).toBe("Some University");
    expect(value[0].institution).not.toMatch(/Fall|Spring|\d{4}/);
  });

  it("peels a single season-qualified year whole", () => {
    const { value } = extractEducation(
      mkEduSection(["B.A. History", "Some University  Fall 2014"]),
    );
    expect(value[0].institution).toBe("Some University");
  });

  it("peels a numeric MM/YYYY range", () => {
    const { value } = extractEducation(
      mkEduSection(["B.S. Biology", "Example College  01/2020 – 05/2020"]),
    );
    expect(value[0].institution).toBe("Example College");
  });

  it("peels an open-ended '… – Current' range", () => {
    const { value } = extractEducation(
      mkEduSection(["B.S. Physics", "Example College  2015 – Current"]),
    );
    expect(value[0].institution).toBe("Example College");
  });

  it("strips a ' · City, ST' middot location off the institution", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science",
        "University of Example · Seattle, WA  Sep 2020 – May 2024",
      ]),
    );
    expect(value[0].institution).toBe("University of Example");
    expect(value[0].location).toBe("Seattle, WA");
  });
});

describe("splitDoubledCity — only collapse the concatenation artifact", () => {
  // The Berkeley artifact: `before` (the institution) already ENDS in the
  // repeated place token, so "Berkeley Berkeley" is the institution's own
  // "Berkeley" glued onto the location's "Berkeley" — collapse to one.
  it("collapses a doubled city when the institution already ends in that place", () => {
    expect(splitDoubledCity("University of California, Berkeley", "Berkeley Berkeley")).toEqual({
      institution: "University of California, Berkeley",
      city: "Berkeley",
    });
  });

  // A genuine doubled place-name city on an institution that does NOT end in
  // that token must stay intact — collapsing "Walla Walla" → "Walla" would
  // corrupt both the city and the institution.
  it("leaves a genuine doubled place-name city untouched", () => {
    expect(splitDoubledCity("Whitman College", "Walla Walla")).toEqual({
      institution: "Whitman College",
      city: "Walla Walla",
    });
  });

  it("returns a non-doubled city unchanged", () => {
    expect(splitDoubledCity("Some University", "San Francisco")).toEqual({
      institution: "Some University",
      city: "San Francisco",
    });
  });

  // The MULTI-WORD artifact: the last-token-only guard saw only "Angeles" and
  // missed the "Los Angeles Los Angeles" glue. Comparing `before`'s trailing
  // N-word suffix against the repeated phrase collapses it correctly.
  it("collapses a doubled MULTI-WORD city when the institution ends in that phrase", () => {
    expect(
      splitDoubledCity(
        "University of California, Los Angeles",
        "Los Angeles Los Angeles",
      ),
    ).toEqual({
      institution: "University of California, Los Angeles",
      city: "Los Angeles",
    });
  });

  it("collapses a SUNY-style multi-word doubled campus city", () => {
    expect(
      splitDoubledCity("University at Buffalo, South Campus", "South Campus South Campus"),
    ).toEqual({
      institution: "University at Buffalo, South Campus",
      city: "South Campus",
    });
  });

  // Regression guard for the widened comparison: a genuine multi-word doubled
  // place-name city whose institution does NOT end in the phrase must still stay
  // intact — "Walla Walla" must not collapse to "Walla".
  it("still leaves a genuine multi-word doubled place-name city untouched", () => {
    expect(splitDoubledCity("Whitman College", "Walla Walla")).toEqual({
      institution: "Whitman College",
      city: "Walla Walla",
    });
  });
});

describe("education — redacted 20XX program dates (#297/#302)", () => {
  // A degree-less program header carrying a redacted template date
  // ("Sep 20XX – May 20XX") must still register as its own entry lead so the
  // segmenter keeps the boundary — the redacted-date case of #302's entry loss.
  it("segments a degree-less program with a redacted 20XX date as its own entry", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science",
        "Stanford University · Palo Alto, CA  Sep 2018 – May 2022",
        "Applied Robotics Program  Sep 20XX – May 20XX",
        "MIT Professional Education",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0].degree).toBe("B.S.");
    expect(value[1].degree).toBe("");
    expect(value[1].field).toBe("Applied Robotics Program");
    expect(value[1].institution).toBe("MIT Professional Education");
  });

  // A bare redacted-date annotation (no program text) must NOT split off a
  // phantom degree-less entry. A season-led "Fall 20XX – Spring 20XX" line is
  // keyword-free (it hits neither the grad-date-lead reject nor the honors
  // denylist), so it genuinely exercises the remainder-emptying path in
  // `isInlineDatedProgram`: the redacted-year (20XX) strip plus the season-word
  // strip leave nothing substantive, so no split.
  it("does not split a bare redacted-date annotation into a phantom entry", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science",
        "Stanford University",
        "Fall 20XX – Spring 20XX",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
  });
});

describe("education — adjacent identical-degree headers, distinct schools (#297 nit)", () => {
  // The dup-degree sub-line guard (`isDupDegreeSubLine`, `li === degreeHeaderLi
  // + 1`) suppresses the "second degree ⇒ new entry" flush for an entry's own
  // polluted institution sub-line. It must NOT over-merge two REAL same-degree
  // entries from different schools that happen to sit adjacent.
  it("splits two adjacent identical-degree headers with distinct institutions", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science",
        "Stanford University",
        "B.S. Computer Science",
        "University of Washington",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value.map((e) => e.institution)).toEqual([
      "Stanford University",
      "University of Washington",
    ]);
    expect(value.map((e) => e.degree)).toEqual(["B.S.", "B.S."]);
  });
});

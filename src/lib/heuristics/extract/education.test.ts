// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
import {
  extractEducation,
  isInlineDatedProgram,
  isInlineDatedProgramEntry,
  splitDoubledCity,
} from "./education.ts";
import { type PdfLine, type PdfSection } from "../sections.ts";
import { OPEN_ENDED_ALT } from "../regex.ts";

// Every real-word inflection `inlineDatedProgramText`'s `(?:${OPEN_ENDED_ALT})(?:ly)?`
// recognises — the pattern also matches nonsense like `Nowly`/`Ongoingly`, which
// this list deliberately omits. Derived from `OPEN_ENDED_ALT` rather than
// restated, so a future word added there cannot ship unpinned at either sweep
// below (#992).
const OPEN_ENDED_FORMS = OPEN_ENDED_ALT.split("|").flatMap((word) =>
  word === "Present" || word === "Current" ? [word, `${word}ly`] : [word],
);

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
    // #367 — leading `Incoming Courses:` / `Relevant Coursework:` label is
    // peeled and the comma-separated list is split into individual courses so
    // each entry is addressable in the reconstructed view.
    expect(value[0].coursework).toEqual(["Deep Learning", "Machine Learning"]);
    expect(value[1].institution).toBe("Northgate State University");
    expect(value[1].coursework).toEqual(["Data Structures", "Algorithms"]);
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

  // #367 — coursework label + comma-split fixture cases.
  it("peels a 'Coursework:' label and splits the comma-separated list (#367)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "State University",
        "B.S. Computer Science, 2020 - 2024",
        "● Coursework: Data Structures, Algorithms, Operating Systems",
      ]),
    );
    expect(value[0].coursework).toEqual([
      "Data Structures",
      "Algorithms",
      "Operating Systems",
    ]);
  });

  it("keeps a single-course bullet as one entry (no comma → no split)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "State University",
        "B.S. Computer Science, 2020 - 2024",
        "● Relevant Coursework: Systems Programming",
      ]),
    );
    expect(value[0].coursework).toEqual(["Systems Programming"]);
  });

  it("splits a bare comma-separated course list even without a leading label", () => {
    const { value } = extractEducation(
      mkEduSection([
        "State University",
        "B.S. Computer Science, 2020 - 2024",
        "● Machine Learning, Computer Vision, Natural Language Processing",
      ]),
    );
    expect(value[0].coursework).toEqual([
      "Machine Learning",
      "Computer Vision",
      "Natural Language Processing",
    ]);
  });

  // #364 — a one-line "Degree — Institution" entry used to store the raw line
  // verbatim as institution AND let parseDegreeAndField swallow the trailing
  // institution into `field`, producing a doubled render.
  it("splits one-line 'Degree in Field — Institution' into clean degree/field/institution (#364)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. in Computer Science — State University",
        "2013",
      ]),
    );
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].institution).toBe("State University");
    expect(value[0].institution).not.toMatch(/B\.S\.|Computer Science/);
  });

  it("handles em-dash / en-dash separator equivalently", () => {
    const { value } = extractEducation(
      mkEduSection([
        "M.Sc. in Data Science – Riverside College",
        "2022",
      ]),
    );
    expect(value[0].institution).toBe("Riverside College");
    expect(value[0].field).toBe("Data Science");
  });

  it("picks the institution-hint part when the shape is 'Institution — Degree — Year' (multi-part)", () => {
    // Reverse ordering of the #364 case: institution FIRST, then degree, then
    // a trailing year. The fix must select the part carrying an INSTITUTION_HINTS
    // token instead of blindly taking the last part.
    const { value } = extractEducation(
      mkEduSection([
        "Stanford University — B.S. Computer Science — 2019",
      ]),
    );
    expect(value[0].institution).toContain("Stanford");
    expect(value[0].degree).toMatch(/B\.S\./);
  });

  // #366 — LaTeX two-column line assembly joins institution and city with a
  // single space. The 1-space fallback splits when the surviving institution
  // prefix has ≥2 tokens; a single-token remainder ("Stanford CA") is
  // ambiguous with a state-suffixed institution and stays glued.
  it("splits '… Institution City, ST' joined by a single space when institution ≥2 tokens (#366)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Lakeside Institute of Technology Seattle, WA",
        "B.S. in Computer Science, 2020 - 2024",
      ]),
    );
    expect(value[0].institution).toBe("Lakeside Institute of Technology");
    expect(value[0].location).toBe("Seattle, WA");
  });

  it("refuses to split when the surviving institution reduces to one token (#366 guard)", () => {
    // Ambiguous case: a single-word institution then a city, state (e.g.
    // "Cornell Ithaca, NY"). Splitting would strip a legit institution token,
    // so the 1-space fallback refuses. Chose 'NY' (unambiguous with degree
    // patterns like BA/MA that DEGREE_RE would otherwise pick up).
    const { value } = extractEducation(
      mkEduSection([
        "Cornell Ithaca, NY",
        "B.S. in Computer Science, 2020 - 2024",
      ]),
    );
    expect(value[0].institution).toBe("Cornell Ithaca, NY");
    expect(value[0].location).toBeUndefined();
  });

  // #371 — a "Dean's List 2015–2017" honors annotation used to poison the
  // parent entry's dates: parseDateRange's range-first preference picked up the
  // annotation range and buried the real graduation year. Filter annotation
  // lines out of the chunk before running parseEducationDates.
  it("does not use a Dean's List annotation year range as the entry's attendance dates (#371)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Computer Science, 2017",
        "GPA: 3.7 · Dean's List 2015–2017",
      ]),
    );
    expect(value[0].institution).toBe("Springfield State University");
    expect(value[0].degree).toBe("B.S.");
    // Correct behavior: the sole date on the entry is the graduation year;
    // start_date must NOT be populated from the annotation range.
    expect(value[0].end_date).toBe("2017");
    expect(value[0].start_date).toBeUndefined();
  });

  it("still uses attendance dates on the degree line when annotations carry no range", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Computer Science, 2015 - 2017",
        "GPA: 3.7 · Cum Laude",
      ]),
    );
    expect(value[0].start_date).toBe("2015");
    expect(value[0].end_date).toBe("2017");
  });

  it("leaves a course NAME that happens to contain 'Courses' mid-string untouched", () => {
    // Anchor-only strip: `COURSEWORK_LABEL_RE` binds at `^` so a course name
    // like "Advanced Courses in AI" is NOT accidentally stripped mid-string.
    const { value } = extractEducation(
      mkEduSection([
        "State University",
        "B.S. Computer Science, 2020 - 2024",
        "● Advanced Courses in AI, Deep Learning",
      ]),
    );
    expect(value[0].coursework).toEqual([
      "Advanced Courses in AI",
      "Deep Learning",
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

  it("does NOT split an honor-society line into a phantom entry, even with a year (#883 review round 2)", () => {
    // "Phi Beta Kappa, cum laude 2021" carries no EDUCATION_ANNOTATION_RE
    // keyword ("honor society" isn't "honors"), and once the trailing "cum
    // laude" note is cut for the #883 GPA-rescue check, "Phi Beta Kappa"
    // reads exactly like a real degree-less program title. This is why
    // isInlineDatedProgram's #883 rescue is scoped to GPA-kind notes only —
    // an honors-kind note falls back to testing the un-cut line, where "cum
    // laude" still correctly vetoes it as an annotation.
    const { value } = extractEducation(
      mkEduSection([
        "Harvard University                                   May 2022",
        "B.A. in Economics",
        "Phi Beta Kappa, cum laude 2021",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("Harvard University");
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

  // #375 — one-line "Institution | Dates" (letter-spaced-name-heading fixture).
  // Old `stripInstitutionDate` peeled only the date and left a trailing " |"
  // glued onto the institution, then `stripInstitutionLocation` didn't clean
  // bare punctuation either. The COL_SEP alternation now consumes the leading
  // column separator alongside the trailing date.
  it("peels a leading '| ' column separator alongside the trailing date (#375)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Bachelor of Science, Computer Science",
        "State University | 2018 - 2022",
      ]),
    );
    expect(value[0].institution).toBe("State University");
    expect(value[0].institution).not.toMatch(/\|/);
  });

  it("peels a leading '· ' middot column separator with the trailing date", () => {
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science",
        "Example College · 2015 – 2019",
      ]),
    );
    expect(value[0].institution).toBe("Example College");
    expect(value[0].institution).not.toMatch(/·/);
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

// PR #417 review — targeted regressions surfaced during the reviewer's pass
// on the batch fixes. Each `it` names the specific reviewer input so the
// intent survives if the shape ever moves.
describe("extractEducation — PR #417 review inputs", () => {
  // #366: a `<Institution> of <City>, ST` construction ("University of Miami,
  // FL") looks like a state-suffixed institution NAME, not institution + city
  // + state — the 1-space fallback used to strand the institution as
  // "University of" and treat the city as location. Reject when the surviving
  // institution prefix ends in a preposition/article.
  it("refuses to split 'University of Miami, FL' (prefix ends in a preposition)", () => {
    const { value } = extractEducation(
      mkEduSection([
        "University of Miami, FL",
        "B.S. in Computer Science, 2018 - 2022",
      ]),
    );
    expect(value[0].institution).toBe("University of Miami, FL");
    expect(value[0].location).toBeUndefined();
  });

  it("refuses to split 'University of Michigan, MI'", () => {
    const { value } = extractEducation(
      mkEduSection([
        "University of Michigan, MI",
        "B.S. in Computer Science, 2018 - 2022",
      ]),
    );
    expect(value[0].institution).toBe("University of Michigan, MI");
    expect(value[0].location).toBeUndefined();
  });

  // #371: legitimate Commonwealth degree shapes carry `Honours` / `Thesis` on
  // the SAME line as the credential + real attendance dates. The annotation
  // filter used to drop the whole line and lose the dates; the DEGREE_RE
  // carve-out keeps any line that also matches a degree.
  it("keeps attendance dates on an 'Honours Bachelor of Science, 2015 - 2019' line", () => {
    const { value } = extractEducation(
      mkEduSection([
        "University of Toronto",
        "Honours Bachelor of Science, 2015 - 2019",
      ]),
    );
    expect(value[0].start_date).toBe("2015");
    expect(value[0].end_date).toBe("2019");
  });

  it("keeps attendance dates on a 'Thesis-based M.Sc. Data Science, 2018 - 2020' line", () => {
    const { value } = extractEducation(
      mkEduSection([
        "McGill University",
        "Thesis-based M.Sc. Data Science, 2018 - 2020",
      ]),
    );
    expect(value[0].start_date).toBe("2018");
    expect(value[0].end_date).toBe("2020");
  });

  // #364: a spaced ASCII `-` commonly separates degree from field ("B.S. -
  // Computer Science"), not institution from the rest, so the em-dash split
  // must not fire on it — otherwise the field ends up glued to the institution.
  it("does not split 'B.S. - Computer Science, Stanford University' at the ASCII hyphen", () => {
    const { value } = extractEducation(
      mkEduSection(["B.S. - Computer Science, Stanford University"]),
    );
    expect(value[0].degree).toBe("B.S.");
    // Field is recovered (was `undefined` in the pre-fix regression, because
    // the ASCII-hyphen split reassigned the credential's tail to institution
    // and left field empty). Disambiguating a comma-separated
    // "<field>, <institution>" is a separate split not in scope for #364; the
    // guarantee here is that the credential's tail is no longer lost.
    expect(value[0].field).toMatch(/Computer Science/);
    // Institution still contains the trailing institution token; the raw
    // whole-line fallback is unchanged for the no-em-dash shape.
    expect(value[0].institution).toMatch(/Stanford/);
  });

  // #367: the per-item Title-case guard used to silently drop a mid-list
  // lowercase course. Whole-bullet semantics restore that: check the FIRST
  // item; if it clears the guard, keep all its comma-separated siblings.
  it("keeps a mid-list lowercase course when the first item is Title-case", () => {
    const { value } = extractEducation(
      mkEduSection([
        "State University",
        "B.S. Computer Science, 2020 - 2024",
        "● Coursework: Data Structures, algorithms, Operating Systems",
      ]),
    );
    expect(value[0].coursework).toEqual([
      "Data Structures",
      "algorithms",
      "Operating Systems",
    ]);
  });
});

describe("extractEducation — entry-boundary guard against phantom entries (#462/#467)", () => {
  it("does NOT anchor a phantom entry on a 'Graduated B.E. with Distinction' body sentence", () => {
    // When a compound header ("CERTIFICATIONS & ACTIVITIES") is unrouted and
    // its body pools into education, a body-prose "Achievements: Graduated
    // B.E. with Distinction; mentored 3 interns" line hits DEGREE_RE and
    // pre-#462/#467 anchored a phantom second degree entry off the fragment.
    // The `isRealDegreeHeader` guard rejects such lines.
    const { value } = extractEducation(
      mkEduSection([
        "B.E. in Computer Science — Ridgemont College",
        "Aug 2017 - Jun 2021",
        "Achievements: Graduated B.E. with Distinction; mentored 3 interns",
        "Leadership: Led CSR initiatives; competed in inter-college hackathons",
      ]),
    );
    // Exactly ONE education entry — no phantom on the sub-labelled prose.
    expect(value).toHaveLength(1);
    expect(value[0].degree).toContain("B.E.");
    expect(value[0].institution).toContain("Ridgemont College");
  });

  it("does NOT anchor on a 'Achievements: …' sub-labelled prefix line", () => {
    // A sub-label prefix ("Achievements:", "Certifications:", "Leadership:")
    // is followed by annotation body — never a real entry header. Even if the
    // body contains a degree token, the entry-boundary guard rejects.
    const { value } = extractEducation(
      mkEduSection([
        "Bachelor of Music, Music Composition",
        "Ridgemont University",
        "2025",
        "Certifications: Music Theory (Ph.D. level)",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toContain("Bachelor of Music");
  });

  it("still anchors a genuine second degree header (no regression)", () => {
    // A real degree header ("B.S. in Computer Science — State University") is
    // not preceded by a body-prose verb or a sub-label prefix, so
    // `isRealDegreeHeader` admits it and the chunker opens a new entry.
    const { value } = extractEducation(
      mkEduSection([
        "M.Sc. in Computer Science — Wingtip University",
        "Jul 2024 - Dec 2025",
        "B.E. in Computer Science — Ridgemont College",
        "Aug 2017 - Jun 2021",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0].degree).toContain("M.Sc.");
    expect(value[1].degree).toContain("B.E.");
  });
});

describe("extractEducation — one-line 'Degree Field, Institution' + en-dash date + plain coursework (#506)", () => {
  it("keeps the degree/field when the only en-dash is inside a trailing date RANGE", () => {
    // The #506 repro: degree + field + institution on ONE line, with a trailing
    // "Mon YYYY – Mon YYYY" range. The date's en-dash used to be mistaken for the
    // degree↔institution separator, burying the credential in `institution` and
    // re-parsing degree from the bare end-date ("May 2023") → empty.
    const { value } = extractEducation(
      mkEduSection([
        "M.S. Data Science, Example State University Aug 2021 – May 2023",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("M.S.");
    expect(value[0].field).toBe("Data Science");
    expect(value[0].institution).toBe("Example State University");
    expect(value[0].institution).not.toMatch(/M\.S\.|Data Science|2021|2023/);
    expect(value[0].start_date).toBe("Aug 2021");
    expect(value[0].end_date).toBe("May 2023");
  });

  it("recovers coursework written as a plain (glyph-less) 'Coursework:' line", () => {
    const { value } = extractEducation(
      mkEduSection([
        "M.S. Data Science, Example State University Aug 2021 – May 2023",
        "Coursework: Databases, Machine Learning, Statistics",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].coursework).toEqual([
      "Databases",
      "Machine Learning",
      "Statistics",
    ]);
  });

  it("attributes plain coursework to the correct entry across two one-line degrees", () => {
    const { value } = extractEducation(
      mkEduSection([
        "M.S. Data Science, Example State University Aug 2021 – May 2023",
        "Coursework: Databases, Machine Learning, Statistics",
        "B.Tech. Electronics Engineering, Sample Institute of Technology Jun 2016 – May 2020",
        "Coursework: Data Structures, RDBMS, Software Engineering",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value[0]).toMatchObject({
      degree: "M.S.",
      field: "Data Science",
      institution: "Example State University",
      coursework: ["Databases", "Machine Learning", "Statistics"],
    });
    expect(value[1]).toMatchObject({
      degree: "B.Tech.",
      field: "Electronics Engineering",
      institution: "Sample Institute of Technology",
      coursework: ["Data Structures", "RDBMS", "Software Engineering"],
    });
  });

  it("preserves a comma inside the institution name (no trailing date)", () => {
    // The comma-split must not cut "University of California, Berkeley" in half:
    // the institution run starts at the first hint-bearing part and keeps the
    // rest, so the campus comma survives.
    const { value } = extractEducation(
      mkEduSection([
        "B.S. Computer Science, University of California, Berkeley",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
    expect(value[0].institution).toBe("University of California, Berkeley");
  });

  it("does NOT comma-split an institution-first line with no degree prefix", () => {
    // The hint sits in the FIRST comma-part ("State University Boston, MA") — the
    // line leads with the institution, there is no "<Degree Field>," head to peel.
    // The comma-split must NOT fire (an empty head would nuke degree/field); the
    // whole line stays the institution and the location peels normally.
    const { value } = extractEducation(
      mkEduSection(["State University Boston, MA"]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("State University");
    expect(value[0].location).toBe("Boston, MA");
  });
});

describe("extractEducation — cleanField strips leftover edge middot and bullet separators (#835)", () => {
  it("strips trailing middot separator from degree field", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Computer Science ·",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
  });

  it("strips trailing bullet separator from degree field", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "Bachelor of Science in Mathematics •",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("Bachelor of Science");
    expect(value[0].field).toBe("Mathematics");
  });

  it("strips leading middot or bullet from degree field", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. · Computer Science",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
  });

  it("strips the separator orphaned by the trailing-date cut", () => {
    // The fixture shape the issue was filed from: the date strip removes "2020"
    // and leaves the "·" that divided it from the field.
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Computer Science · 2020",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
  });

  it("preserves an INTERIOR middot joining a genuine two-part field", () => {
    // The strip is anchored at both ends, so a separator that is real content
    // survives. This is what stops a future widening from de-anchoring it.
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Mathematics · Statistics",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Mathematics · Statistics");
  });

  it("preserves an internal ampersand inside a compound field name", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. in Computer Science & Engineering ·",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science & Engineering");
  });

  it("returns undefined field when only separators survive", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. · • -",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBeUndefined();
  });
});

describe("extractEducation — parseDegreeAndField strips middot/bullet before in/of connective (#839)", () => {
  it("strips middot then in connective from degree field", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. · in Computer Science",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
  });

  it("strips bullet then of connective from degree field", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. • of Computer Science",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Computer Science");
  });

  it("still strips hyphen and em dash before in connective", () => {
    const { value: hyphen } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. - in Computer Science",
      ]),
    );
    expect(hyphen[0].field).toBe("Computer Science");

    const { value: emDash } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. — in Computer Science",
      ]),
    );
    expect(emDash[0].field).toBe("Computer Science");
  });

  it("preserves interior middot in a two-part field name", () => {
    const { value } = extractEducation(
      mkEduSection([
        "Springfield State University",
        "B.S. Mathematics · Statistics",
      ]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].degree).toBe("B.S.");
    expect(value[0].field).toBe("Mathematics · Statistics");
  });
});

describe("isInlineDatedProgram: a date word must be a whole word (#925)", () => {
  // The strip inside this predicate DELETES what it matches, then asks whether
  // substantive text is left. With a `[a-z]*` tail on the month/season/`present`
  // alternation it matched any word STARTING with one, so a single-word program
  // name was erased and the line was rejected as a bare date. `Marketing` begins
  // with `Mar` — the same hazard #380 fixed on the sibling `ATTENDANCE_RANGE_END`,
  // which is why that one already uses the enumerated STRICT_MONTH.
  it.each([
    "Marketing 2020",
    "Marketing (2020)",
    "Marketing, 2020",
    "Decision 2021",
  ])("accepts a program whose name merely starts with a date word: %s", (line) => {
    expect(isInlineDatedProgram(line)).toBe(true);
  });

  // `Junior Fellowship 2019` is deliberately NOT one of these: it is rejected,
  // and correctly so — `EDUCATION_ANNOTATION_RE` lists `fellowships?`, and a
  // fellowship line is an annotation on the current school, not a new program.
  // The prefix cases below carry no denylist word, so they isolate the month
  // prefix and nothing else.
  // SINGLE-WORD on purpose (#951 review). The multi-word forms these replaced
  // (`Marathon Training Program 2019`, `Junior Analyst Program 2020`, …) pass
  // pre-fix too: the loose tail erased the prefix-matched word, but `Training
  // Program` / `Analyst Program` survived and carried the remainder test on
  // their own. A block named for the prefix must fail when the prefix fix is
  // reverted, and only the single-word form does.
  //
  // `Oct` changes word deliberately: `October Intensive 2022` cannot reduce,
  // because `October 2022` is a real date line and must stay `false`. `Octagon`
  // is the nearest input that isolates the prefix; the control that keeps the
  // reduction honest is the `October 2022` row in the bare-date-line block
  // below, next to its siblings (#951 review).
  it.each([
    ["Marathon 2019", "Mar"],
    ["Junior 2020", "Jun"],
    ["Augmented 2021", "Aug"],
    ["Presentation 2020", "present"],
    ["Decorative 2017", "Dec"],
    ["Octagon 2022", "Oct"],
  ])("is not fooled by the prefix in %s (starts with %s)", (line) => {
    expect(isInlineDatedProgram(line)).toBe(true);
  });

  it.each([
    "Marketing Certificate 2020",
    "MIT Applied Data Science (2023)",
    "Data Science Certificate 2020",
  ])("still accepts a multi-word program: %s", (line) => {
    expect(isInlineDatedProgram(line)).toBe(true);
  });

  // The behaviour the strip exists to produce, and the half a narrowing could
  // silently break: a line made only of date words is still not a program.
  it.each([
    "Fall 2013 – Spring 2014",
    "May 2011",
    "September 2020",
    "Sept. 2019",
    "Sep 2019",
    "Spring 2019",
    "Summer 2013, 2014",
    // The control for the prefix block above: `October Intensive 2022` could
    // not reduce to a single word without asserting a real date line is a
    // program, so `Oct` changed word instead (#951 review).
    "October 2022",
    // Dropping the `[a-z]*` tail took `Presently` with it, and this line then
    // became an entry whose institution was the date range itself (#951 review
    // round 2). Pinned here rather than with the plural seasons: it is a bare
    // date line, not a season inflection.
    "Fall 2013 – Presently",
  ])("still rejects a bare date line: %s", (line) => {
    expect(isInlineDatedProgram(line)).toBe(false);
  });

  // An earlier round of this PR dropped the season inflection entirely, so a
  // plural season survived the strip as "program text". That was wrong, and the
  // cost was not the one being weighed: `Winters Institute 2020` passes either
  // way, so the relaxation bought nothing there, while a plural-season DATE line
  // became an entry. Seasons now carry `s?` and nothing wider (#951 review).
  it.each([
    "Summers 2013, 2014",
    "Springs 2014",
    "Falls 2019",
    "Autumns 2020",
    "Winters 2013 - Springs 2014",
  ])("still rejects a plural-season date line: %s", (line) => {
    expect(isInlineDatedProgram(line)).toBe(false);
  });

  it("keeps a program name that merely starts with a season word", () => {
    // The `\b` lands after the optional `s`, so the inflection never reaches
    // into an ordinary word. SINGLE-WORD on purpose: the multi-word forms these
    // replaced (`Springfield Academy 2020`, `Fallow Institute 2019`) pass under
    // the loose `[a-z]*` tail too — `Academy` / `Institute` carries the
    // remainder test on its own — so they pinned nothing (#951 review).
    // `Summersville` is the row that pins `s?`-then-`\b`: it is the only input
    // here where the optional `s` is followed by more letters.
    expect(isInlineDatedProgram("Springfield 2020")).toBe(true);
    expect(isInlineDatedProgram("Fallow 2019")).toBe(true);
    expect(isInlineDatedProgram("Wintergreen 2021")).toBe(true);
    expect(isInlineDatedProgram("Summersville 2018")).toBe(true);
    // Cannot reduce to `Winters 2020`: that IS a plural-season date line and is
    // pinned `false` above. Kept multi-word as a control, not as a prefix pin.
    expect(isInlineDatedProgram("Winters Institute 2020")).toBe(true);
  });

  it("keeps a program name that merely starts with `present`", () => {
    // The mirror of the block above, for the literal that carries `(?:ly)?`.
    // `Presentation 2020` is already pinned in the prefix block at the top;
    // these two are the inflection's own neighbours, and stripping them would
    // be the exact defect #925 fixed, one word over.
    expect(isInlineDatedProgram("Presents 2020")).toBe(true);
    expect(isInlineDatedProgram("Presenting 2020")).toBe(true);
  });

  // `extractEducation`-level pins. The predicate-level ones above would not
  // have caught what the #951 review found: the damage shows up here, where a
  // date word became a `field` on the school after it, and with no school after
  // it, an entry whose institution was a bare date. Uses the shared
  // `mkEduSection` rather than a hand-rolled section — the hand-rolled one
  // needed an `as unknown as PdfSection` cast, which is precisely the check
  // that catches drift when `PdfLine` gains a required field (#951 review).
  const runEdu = (texts: string[]) => extractEducation(mkEduSection(texts)).value;

  it("does not let a plural-season date line reach an education entry", () => {
    const polluted = runEdu([
      "Yale University",
      "B.A. History, 2010 - 2014",
      "Summers 2013, 2014",
      "Harvard Summer School",
    ]);
    expect(polluted).toHaveLength(2);
    expect(polluted[1].institution).toBe("Harvard Summer School");
    expect(polluted[1].field).toBeUndefined();

    const fabricated = runEdu([
      "Yale University",
      "B.A. History, 2010 - 2014",
      "Summers 2013, 2014",
    ]);
    expect(fabricated).toHaveLength(1);
    expect(fabricated[0].institution).toBe("Yale University");
  });

  // The sibling of the block above, and what the `(?:ly)?` inflection exists
  // for: `main` rejected `Fall 2013 – Presently` through the `[a-z]*` tail,
  // and dropping that tail turned this into a fabricated credential whose
  // institution was the date range itself (#951 review round 2). Only the
  // season-led form ever slipped — `DATE_LEAD_RE` rejects the month- and
  // year-led shapes before the strip runs at all, which is the same
  // asymmetry #952 turns on.
  //
  // Swept over the open-ended vocabulary rather than `Presently` alone (#987),
  // so a regression fails as a wrong entry and not only as a wrong boolean the
  // #952 block below would catch. Of the six forms, three regress: on `main`
  // before #985 the `polluted` half gave Harvard `field: "Fall"` for
  // `Currently` / `Ongoing` / `Now`, while `Present`, `Presently` and
  // `Current` came out clean — which is why #952's probe found nothing at
  // this level. `Presently` stays in the sweep as #951's own pin; `Present`
  // and `Current` are swept here too (#992) because a predicate-level pin
  // does not protect this entry-level invariant, and the whole sweep is
  // derived from `OPEN_ENDED_ALT` so a future word cannot ship unpinned.
  //
  // The `fabricated` half holds for every word in the list on both sides of
  // #985; it is here as the other direction of the same invariant, not as a
  // second regression.
  it.each(OPEN_ENDED_FORMS)(
    "does not let a season-led open-ended range ending in %s reach an education entry",
    (openEnded) => {
      const fabricated = runEdu([
        "Yale University",
        "B.A. History, 2010 - 2014",
        `Fall 2013 – ${openEnded}`,
      ]);
      expect(fabricated).toHaveLength(1);
      expect(fabricated[0].institution).toBe("Yale University");

      const polluted = runEdu([
        "Yale University",
        "B.A. History, 2010 - 2014",
        `Fall 2013 – ${openEnded}`,
        "Harvard Summer School",
      ]);
      expect(polluted).toHaveLength(2);
      expect(polluted[1].institution).toBe("Harvard Summer School");
      expect(polluted[1].field).toBeUndefined();
    },
  );

  it("keeps the month-plural asymmetry honest at the entry level", () => {
    // `education.ts` claims `Junes` / `Marches` flip the predicate but come out
    // identical through `extractEducation`. That holds through a DIFFERENT
    // expression than the one this PR changed: `stripInstitutionDate` composes
    // the loose `MONTH`, whose `[a-z]*` tail swallows `Junes`, while the same
    // expression uses the bare `SEASON` with no inflection — which is exactly
    // why `Summers` reached an entry and `Junes` does not. Pinned from this
    // side so the claim cannot rot if that neighbour changes (#951 review).
    const withSchool = runEdu([
      "Yale University",
      "B.A. History, 2010 - 2014",
      "Junes 2013, 2014",
      "Harvard Summer School",
    ]);
    expect(withSchool).toHaveLength(2);
    expect(withSchool[1].institution).toBe("Harvard Summer School");
    expect(withSchool[1].field).toBeUndefined();

    const alone = runEdu([
      "Yale University",
      "B.A. History, 2010 - 2014",
      "Junes 2013, 2014",
    ]);
    expect(alone).toHaveLength(1);
    expect(alone[0].institution).toBe("Yale University");
  });
});

describe("isInlineDatedProgram: every open-ended word is a date word (#952)", () => {
  // The strip used to spell `present` as a literal and omit the rest of
  // `OPEN_ENDED_ALT`, so a season-led range ending in any other open-ended
  // word left that word behind as "program text". Season-led only: a month-
  // or year-led range is rejected earlier by `DATE_LEAD_RE`. Derived from
  // `OPEN_ENDED_ALT` (via `OPEN_ENDED_FORMS`, #992) rather than restated, so
  // this vocabulary can't drift from the entry-level sweep above it.
  it.each(OPEN_ENDED_FORMS.map((word) => `Fall 2013 - ${word}`))(
    "rejects a season-led open-ended range: %s",
    (line) => {
      expect(isInlineDatedProgram(line)).toBe(false);
    },
  );

  // The en dash and the month-led lead test different axes (separator, lead
  // word) than the vocabulary swept above, so one representative word per
  // row is enough here — literal on purpose, not a second vocabulary copy.
  it.each(["Fall 2013 – Current", "Fall 2013 – Currently", "Sept 2019 – Present"])(
    "rejects other separator/lead-word variants of an open-ended range: %s",
    (line) => {
      expect(isInlineDatedProgram(line)).toBe(false);
    },
  );

  // Multi-word names whose FIRST word is open-ended: the rest carries the
  // remainder test. The single-word rows pin the whole-word boundary — each
  // name merely begins with an open-ended word and must not be erased.
  it.each([
    "Now Foundations Program 2020",
    "Current Affairs Certificate 2021",
    "Ongoing Research Seminar 2022",
    "Nowhere 2020",
    "Currency 2021",
  ])("keeps a program whose name contains an open-ended word: %s", (line) => {
    expect(isInlineDatedProgram(line)).toBe(true);
  });
});

describe("a one-word line beside a year must not mint a school (#979)", () => {
  // A misspelled month is not in the vocabulary and never can be — the space of
  // misspellings is open — so `Setember 2021` survived the date strip as
  // `Setember`, passed the "substantive text is left" test, and the parser
  // emitted a SCHOOL by that name. That is the fabricated-credential class: the
  // output names an institution the résumé does not contain, which is strictly
  // worse than the date-attachment miss #925 fixes.
  //
  // The fix is not about months, and deliberately not a spell corrector. It is
  // about what a remainder has to look like before an ENTRY is opened on it: a
  // single capitalised token beside a year, with no program word, carries no
  // evidence that it is a credential — and a mangled date leaves exactly one
  // LETTER-BEARING token however the range around it is punctuated.
  const BASE = ["Yale University", "B.A. History, 2010 - 2014"];

  it.each(["Setember 2021", "Agust 2018", "Jnuary 2020"])(
    "does not open a second entry on %s",
    (line) => {
      const { value } = extractEducation(mkEduSection([...BASE, line]));
      expect(value).toHaveLength(1);
      expect(value[0].institution).toBe("Yale University");
    },
  );

  it.each([
    "Agust 2018 - 2020",
    "Agust 2018-2020",
    "Agust 2018 - Present",
    "Agust 2018 – 2020",
    "Setember 12, 2021",
  ])("does not open a second entry on the RANGE form %s", (line) => {
    // The gate counts letter-bearing tokens, and this row is why (#979 review
    // round 2). `-` is kept inside a word so that `Post-Graduate` counts once,
    // which also left the bare hyphen of an ASCII range standing as a token of
    // its own: `Agust` + `-` read as two words and walked through. The day
    // number in `Setember 12, 2021` did the same. The ASCII-hyphen range is the
    // ordinary way a résumé writes a range, so these are the normal shape of
    // the input — the en-dash row is here as the form that already passed, to
    // pin that all five now agree.
    const { value } = extractEducation(mkEduSection([...BASE, line]));
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("Yale University");
  });

  it.each(["Setember 2021", "Agust 2018", "Jnuary 2020"])(
    "preserves the school following %s as a second entry (AC 2 relaxed for #302 round-trip)",
    (line) => {
      // AC 2 trade-off note (#979 review finding 1):
      // When a one-token line beside a year is followed by an institution line,
      // `isProgramLeadAt` sees the exact same shape as a legitimate one-word program
      // ("Photography 2020" / "Coursera"). Keeping `isProgramLeadAt` loose preserves
      // real one-word programs on parse and on export round-trip (#302), trading the
      // rare fabricated field on an adversarial synthetic input for no entry loss
      // on real resumes. The school itself is correctly preserved as the
      // institution, and no second school named after the misspelling is minted.
      const { value } = extractEducation(
        mkEduSection([...BASE, line, "Harvard Summer School"]),
      );
      expect(value).toHaveLength(2);
      expect(value[0].institution).toBe("Yale University");
      expect(value[1].institution).toBe("Harvard Summer School");
    },
  );

  it("preserves one-word degree-less program leads with institution partner", () => {
    const input = [
      "Photography 2020",
      "Coursera",
      "Welding 2019",
      "Lincoln Technical Institute",
    ];
    const { value } = extractEducation(mkEduSection(input));
    expect(value).toHaveLength(2);
    expect(value[0].institution).toBe("Coursera");
    expect(value[0].field).toBe("Photography");
    expect(value[0].year ?? value[0].end_date).toBe("2020");
    expect(value[1].institution).toBe("Lincoln Technical Institute");
    expect(value[1].field).toBe("Welding");
    expect(value[1].year ?? value[1].end_date).toBe("2019");
  });

  it("preserves one-word degree-less program following a degreed entry", () => {
    const input = [
      ...BASE,
      "Photography 2020",
      "Coursera",
    ];
    const { value } = extractEducation(mkEduSection(input));
    expect(value).toHaveLength(2);
    expect(value[0].institution).toBe("Yale University");
    expect(value[1].institution).toBe("Coursera");
    expect(value[1].field).toBe("Photography");
    expect(value[1].year ?? value[1].end_date).toBe("2020");
  });

  it("catches the whole one-token class, not just misspelled months", () => {
    // `Zebra` and `Banking` reached the same fabrication by the same route.
    // Enumerating month misspellings would have fixed three inputs and left the
    // shape intact; this pins that the gate is about the SHAPE.
    for (const line of ["Zebra 2020", "Banking 2020", "Running 2020"]) {
      const { value } = extractEducation(mkEduSection([...BASE, line]));
      expect(value, line).toHaveLength(1);
    }
  });

  it("still opens an entry on a real program title", () => {
    // Two tokens is enough — and `Certificate` is the word that makes these
    // read as credentials rather than as stray proper nouns.
    for (const line of [
      "Marketing Certificate 2020",
      "Data Science Certificate 2020",
    ]) {
      const { value } = extractEducation(mkEduSection([...BASE, line]));
      expect(value, line).toHaveLength(2);
      expect(value[1].institution, line).toBe(line.replace(/\s*20\d{2}$/, ""));
    }
  });

  it("leaves the #925 controls exactly as they were", () => {
    // `Marketing 2020` alone already produced one entry before this change (a
    // downstream strip erased the word), and it still does. The control is that
    // the OUTPUT is unchanged, not that the path through it is.
    const { value } = extractEducation(mkEduSection([...BASE, "Marketing 2020"]));
    expect(value).toHaveLength(1);
    expect(value[0].institution).toBe("Yale University");
  });

  it("keeps the strip predicate and the entry gate as separate questions", () => {
    // `isInlineDatedProgram` answers "did a real word survive the date strip, or
    // was this line only a date?" — and a one-word survivor is the RIGHT answer
    // there; that is precisely what #925/#951 proved the strip must not eat.
    // What changed is that surviving is no longer a licence to mint a school.
    for (const line of [
      "Springfield 2020",
      "Fallow 2019",
      "Presenting 2020",
      "Setember 2021",
    ]) {
      expect(isInlineDatedProgram(line), line).toBe(true);
      expect(isInlineDatedProgramEntry(line), line).toBe(false);
    }
  });

  it("admits a one-word remainder that names a credential", () => {
    // The positive vocabulary's whole job: one token is not disqualifying, an
    // EVIDENCE-FREE one token is.
    expect(isInlineDatedProgramEntry("Certificate 2020")).toBe(true);
    expect(isInlineDatedProgramEntry("Diploma 2019")).toBe(true);
    expect(isInlineDatedProgramEntry("Bootcamp 2021")).toBe(true);
  });

  it("keeps an intra-word hyphen, period and ampersand as ONE token", () => {
    // The counterpart of the range rows above: dropping non-letter tokens must
    // not also split the words the keep-set exists to hold together. Each line
    // here has a genuine second word, and would still pass if the first were
    // split — so the assertion that carries the weight is the one-word row.
    expect(isInlineDatedProgramEntry("Post-Graduate Diploma 2019")).toBe(true);
    expect(isInlineDatedProgramEntry("R&D Certificate 2021")).toBe(true);
    expect(isInlineDatedProgramEntry("MIT Applied Data Science (2023)")).toBe(true);
    // One word by virtue of the keep-set, and a credential by vocabulary: if
    // the hyphen split it, this would be two tokens and pass for the wrong
    // reason; if the hyphen were dropped as a token, it stays one and passes
    // through `PROGRAM_TITLE_WORD_RE`.
    expect(isInlineDatedProgramEntry("Post-Graduate 2019")).toBe(false);
  });

  it("still rejects every real date line", () => {
    // The gate narrows what opens an entry; it must not widen it anywhere.
    for (const line of [
      "May 2011",
      "September 2020",
      "Sept. 2019",
      "Fall 2013 – Spring 2014",
      "Summers 2013, 2014",
      "Fall 2013 – Presently",
    ]) {
      expect(isInlineDatedProgram(line), line).toBe(false);
      expect(isInlineDatedProgramEntry(line), line).toBe(false);
    }
  });
});


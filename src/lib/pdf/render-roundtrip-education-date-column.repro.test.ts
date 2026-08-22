// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #882 — EVERY education date draws in the flush-right date column, and every
 * newly-admitted shape survives a real pdfjs round-trip.
 *
 * WHAT CHANGED. The flush-right decision used to be
 * `isLoneDateRange(eduDates, { allowSingle: true })` — a predicate SHARED with
 * the parser's `columnGapCuts`, which admits a two-anchor range and (since #618)
 * a bare four-digit year, and nothing else. So a lone `May 2024` — the single
 * most common graduation shape there is — fell through to a glued
 * `[org, date].join("  ")` and drew two spaces after the institution, while an
 * apostrophe year and a season-led date did the same. #882 replaces that gate
 * with `educationDateDrawsFlushRight`, an EXPORTER-owned predicate that says yes
 * to any non-empty date, and leaves `isLoneDateRange` and every parser call site
 * untouched.
 *
 * WHY THAT NEEDS THIS TEST AND NOT A UNIT ASSERTION. Only a RANGE has the
 * `flush()` date-range exemption to protect it. Every other shape is safe purely
 * because pdfjs synthesizes a whitespace filler item across the flush-right gap
 * on our own export, leaving a measured x-gap of ≈0pt — far under
 * `COLUMN_GAP_THRESHOLD` — so `columnGapCuts` never computes a cut and the line
 * re-parses as ONE line. That is a pdfjs implementation detail with no pinned
 * contract. If a pdfjs upgrade stopped emitting the filler, the gap becomes
 * ≈360pt, the date peels onto its own `PdfLine`, and the entry's date anchor is
 * gone — silently. #618 shipped `render-roundtrip-education-lone-year.repro.test.ts`
 * to pin that for the lone-year shape; this file is the same treatment for every
 * shape #882 newly admits. It renders real bytes and re-parses them through the
 * real cascade. READ IT BEFORE BUMPING pdfjs.
 *
 * THE STRONGEST FORM OF THE CLAIM, pinned directly. The safety argument is not
 * "the date survives" but something sharper: the drawn text is the SAME either
 * way, so a flush-right date and a glued one must re-parse to the IDENTICAL
 * education array. {@link expectColumnMatchesGlue} asserts exactly that against a
 * hand-built glued twin of each shape. It is a stronger pin than a per-field
 * assertion, and it is the reason two shapes below can be pinned honestly at all:
 * an apostrophe year and an `Expected …` qualifier leave residue on the
 * institution string, and this control proves that residue is a PRE-EXISTING
 * parser limitation (the glued twin produces it too), not something the date
 * column introduced. Fixing it is a parser question, out of #882's scope.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../heuristics/types.ts";
import type { ResumeEducation } from "../score/types.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "../heuristics/sections.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

function makeResult(education: ResumeEducation[]): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Rowan Beckett",
        email: "rowan.beckett@example.com",
        phone: "(415) 555-0142",
        location: "Austin, TX",
        summary: "Backend engineer with a decade building high-scale services.",
        skills: ["Go", "Distributed Systems"],
        experience: [
          {
            title: "Staff Engineer",
            company: "Globex",
            start_date: "Jan 2020",
            end_date: "Mar 2023",
            description: "Rebuilt the billing pipeline to cut latency by 40%",
          },
        ],
        education,
        projects: [],
        heuristic_achievements: [],
      } as unknown as HeuristicParsedResume,
      sections: {
        byName: new Map(),
        accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
        source: "regex",
      },
      fieldConfidence: {},
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

const INSTITUTION = "Ridgemont State University";

function educationOf(model: AtsResumeModel) {
  return model.sections.find((s) => s.heading === "Education")!.entries;
}

async function reparse(model: AtsResumeModel) {
  const parsed = await runCascade((await renderAtsResumePdf(model)).bytes);
  return parsed.canonical.fields.education ?? [];
}

/**
 * The same model with every education date moved OUT of the flush-right column
 * and glued back onto its header line after the two-space join the pre-#882
 * fallback used — i.e. what this exact résumé drew before #882.
 */
function gluedTwin(model: AtsResumeModel): AtsResumeModel {
  return {
    ...model,
    sections: model.sections.map((section) =>
      section.heading !== "Education"
        ? section
        : {
            ...section,
            entries: section.entries.map(({ headerLineDate, ...entry }) => ({
              ...entry,
              headerLine: [entry.headerLine, headerLineDate]
                .filter(Boolean)
                .join("  "),
            })),
          },
    ),
  };
}

/**
 * The load-bearing pin: a date drawn in the flush-right COLUMN must re-parse to
 * exactly what the same date GLUED onto the header line re-parses to. Equal means
 * pdfjs still closes the flush-right gap with its filler item and `columnGapCuts`
 * still sees one line — the entire basis for admitting shapes that have no
 * `flush()` exemption of their own.
 */
async function expectColumnMatchesGlue(model: AtsResumeModel) {
  const column = await reparse(model);
  const glued = await reparse(gluedTwin(model));
  expect(column).toEqual(glued);
  return column;
}

describe("#882 — every education date shape draws in the flush-right column", () => {
  // Each row is a date shape `isLoneDateRange` does NOT admit (so pre-#882 it
  // drew glued), except the two controls, which it does and which must not move.
  const SHAPES: Array<{
    name: string;
    edu: ResumeEducation;
    drawn: string;
    control?: true;
  }> = [
    {
      name: "lone month-year — the most common graduation shape of all",
      edu: { degree: "BS Computer Science", institution: INSTITUTION, end_date: "May 2024" },
      drawn: "May 2024",
    },
    {
      name: "apostrophe year",
      edu: { degree: "BS Computer Science", institution: INSTITUTION, end_date: "'19" },
      drawn: "'19",
    },
    {
      name: "season-led lone date",
      edu: { degree: "BS Computer Science", institution: INSTITUTION, end_date: "Spring 2024" },
      drawn: "Spring 2024",
    },
    {
      name: "season-led range",
      edu: {
        degree: "BS Computer Science",
        institution: INSTITUTION,
        start_date: "Fall 2020",
        end_date: "Spring 2024",
      },
      drawn: "Fall 2020 – Spring 2024",
    },
    {
      name: "`Expected` graduation qualifier",
      edu: { degree: "BS Computer Science", institution: INSTITUTION, end_date: "Expected May 2026" },
      drawn: "Expected May 2026",
    },
    {
      name: "in-progress enrolment",
      edu: {
        degree: "PhD Applied Mathematics",
        institution: INSTITUTION,
        start_date: "Sep 2022",
        is_current: true,
        year: "2022",
      },
      drawn: "Sep 2022 – Present",
    },
    {
      name: "bare year (control — already admitted by #618)",
      edu: { degree: "BS Computer Science", institution: INSTITUTION, year: "2023" },
      drawn: "2023",
      control: true,
    },
    {
      name: "month range (control — already admitted, has the flush() exemption)",
      edu: {
        degree: "MS Data Science",
        institution: INSTITUTION,
        start_date: "Sep 2019",
        end_date: "May 2021",
      },
      drawn: "Sep 2019 – May 2021",
      control: true,
    },
  ];

  for (const { name, edu, drawn } of SHAPES) {
    describe(name, () => {
      const model = () => buildAtsResumeModel(makeResult([edu]), fakeScore);

      it("routes the date to the date column, leaving the institution header clean", () => {
        const entry = educationOf(model())[0];
        expect(entry.headerLine).toBe(INSTITUTION);
        expect(entry.headerLineDate).toBe(drawn);
        // Never glued into the drawn text, and never on the degree sub-line.
        expect(entry.headerLine).not.toContain(drawn);
        expect(entry.subLineDate).toBeUndefined();
      });

      it("re-parses to ONE entry, identically to the same date drawn glued", async () => {
        const reEdu = await expectColumnMatchesGlue(model());
        // The failure a pdfjs regression would cause: the date peels onto its own
        // PdfLine and either strands a date-only entry or loses the anchor.
        expect(reEdu.length).toBe(1);
        expect(reEdu[0]?.degree).toBeTruthy();
      });
    });
  }
});

describe("#882 — the date VALUE survives for every shape the parser recognises", () => {
  it("recovers a lone month-year onto the entry, institution free of it", async () => {
    const reEdu = await reparse(
      buildAtsResumeModel(
        makeResult([
          { degree: "BS Computer Science", institution: INSTITUTION, end_date: "May 2024" },
        ]),
        fakeScore,
      ),
    );
    expect(reEdu[0]?.institution).toBe(INSTITUTION);
    expect(reEdu[0]?.end_date).toBe("May 2024");
    expect(reEdu[0]?.year).toBe("2024");
  });

  it("recovers `is_current` for an in-progress entry — 'Present' is not dropped (#882)", async () => {
    const reEdu = await reparse(
      buildAtsResumeModel(
        makeResult([
          {
            degree: "PhD Applied Mathematics",
            institution: INSTITUTION,
            start_date: "Sep 2022",
            is_current: true,
            year: "2022",
          },
        ]),
        fakeScore,
      ),
    );
    // Pre-#882 `ResumeEducation` had no `is_current` at all and
    // `parseEducationDates` discarded the open end, so this drew a bare
    // "Sep 2022" and the résumé stopped saying the degree was in progress.
    expect(reEdu[0]?.institution).toBe(INSTITUTION);
    expect(reEdu[0]?.start_date).toBe("Sep 2022");
    expect(reEdu[0]?.is_current).toBe(true);
    expect(reEdu[0]?.end_date).toBeUndefined();
  });

  it("composes `start_date` + graduation `year` into a range instead of dropping the year (#882)", async () => {
    // The reachable edit-surface defect: the education card exposes start/end as
    // separate cells, so adding a start date to a year-only parse used to delete
    // the graduation year from the export — `formatExperienceDateRange` returns
    // the start alone when there is no end, so the old `|| edu.year` never ran.
    const model = buildAtsResumeModel(
      makeResult([
        {
          degree: "BS Computer Science",
          institution: INSTITUTION,
          start_date: "Sep 2020",
          year: "2024",
        },
      ]),
      fakeScore,
    );
    expect(educationOf(model)[0].headerLineDate).toBe("Sep 2020 – 2024");
    const reEdu = await reparse(model);
    expect(reEdu[0]?.start_date).toBe("Sep 2020");
    expect(reEdu[0]?.end_date).toBe("2024");
  });

  it("leaves EXPERIENCE date rendering untouched — the shared formatter still sees no `year` (#882)", () => {
    // `formatExperienceDateRange` is shared with real experience entries, which
    // have no `year` field at all. The education-only `year`-as-end-anchor
    // fallback lives in `educationDateAnchors`, ahead of the formatter, so an
    // experience row's rendering cannot change.
    const model = buildAtsResumeModel(makeResult([]), fakeScore);
    const exp = model.sections.find((s) => s.heading === "Experience")!.entries[0];
    expect(exp.headerLineDate).toBe("Jan 2020 – Mar 2023");
  });
});

/**
 * The #302 failure arriving through #882's new door.
 *
 * Leading with the institution moves the entry boundary onto a line the
 * segmenter's `INSTITUTION_HINTS` cannot see for any school whose name lacks
 * `University|College|Institute|School|Academy|Polytechnic` — `MIT`,
 * `Georgia Tech`, `Caltech`, `Wharton`. This is the unit companion to the real
 * proof, which is the corpus fixture
 * `tests/fixtures/pdfs/unknown/education-hintless-institution-lead.pdf` and its
 * gate in `corpus-roundtrip.test.ts`: a hand-built model cannot show that a
 * third-party PDF written this way parses correctly in the FIRST place.
 */
describe("#882 — two hint-less institutions round-trip as two entries", () => {
  it("keeps `MIT` and `Georgia Tech` separate, each with its own degree and date", async () => {
    const reEdu = await reparse(
      buildAtsResumeModel(
        makeResult([
          { degree: "MS", field: "Computer Science", institution: "MIT", end_date: "May 2022" },
          {
            degree: "BS",
            field: "Computer Science",
            institution: "Georgia Tech",
            end_date: "May 2020",
          },
        ]),
        fakeScore,
      ),
    );
    expect(reEdu.length).toBe(2);
    // The pre-cue failure was NOT a count change — the chunks shifted by a line,
    // so the degrees came back paired with the WRONG schools. Assert the pairing.
    expect(reEdu.map((e) => [e.institution, e.degree, e.end_date])).toEqual([
      ["MIT", "MS", "May 2022"],
      ["Georgia Tech", "BS", "May 2020"],
    ]);
  });
});

/**
 * The same #302 failure with the date removed — the shape no segmenter cue can
 * see.
 *
 * A DATELESS hint-less institution satisfies none of the four education-lead
 * cues: `INSTITUTION_HINTS` misses the name by construction, `isInstitutionLeadAt`
 * requires an inline date on the institution line, and the hint-less fallback
 * requires a hint match to have set `hasInstitution`. Leading with it therefore
 * exports an entry with NO boundary at all, and the next entry's institution is
 * absorbed into the previous one. `orgCanLead` gates on the date column for
 * exactly this reason, so this shape falls back to the degree-led form that
 * anchors on `DEGREE_RE`.
 */
describe("#882 — dateless hint-less institutions round-trip as two entries", () => {
  it("keeps `MIT` and `Caltech` separate when neither entry carries a date", async () => {
    const reEdu = await reparse(
      buildAtsResumeModel(
        makeResult([
          { degree: "B.S.", field: "Computer Science", institution: "MIT" },
          { degree: "M.S.", field: "Physics", institution: "Caltech" },
        ]),
        fakeScore,
      ),
    );
    expect(reEdu.length).toBe(2);
    expect(reEdu.map((e) => [e.institution, e.degree, e.field])).toEqual([
      ["MIT", "B.S.", "Computer Science"],
      ["Caltech", "M.S.", "Physics"],
    ]);
  });
});

/**
 * A hint-LESS institution followed by a hint-BEARING one (#882 review, PR #889).
 *
 * `isInstitutionLeadAt` stays hint-less-only by design (see its own docblock —
 * broadening it to admit hinted leads too was tried and reverted, since it
 * regressed an unrelated corpus fixture's multi-entry chunking). The actual gap
 * this catches was in `hasInstitution` tracking: it was set only by the
 * hint-based `isInst` cue, so a hint-less institution-led entry (`MIT`) never
 * set it, and the segmenter's OTHER cue (`isInst && hasInstitution`) then
 * couldn't see the boundary when a hint-bearing school (`Stanford University`)
 * followed it — `hasInstitution` read false even though the chunk plainly had
 * an institution. Reviewer-verified failure before the fix: MIT vanished
 * entirely and Stanford inherited MIT's degree and graduation date.
 */
describe("#882 — a hint-less institution followed by a hint-bearing one round-trips as two entries", () => {
  it("keeps `MIT` and `Stanford University` separate, each with its own degree and date", async () => {
    const reEdu = await reparse(
      buildAtsResumeModel(
        makeResult([
          { degree: "M.S.", field: "Computer Science", institution: "MIT", end_date: "May 2022" },
          {
            degree: "B.S.",
            field: "Computer Science",
            institution: "Stanford University",
            end_date: "May 2020",
          },
        ]),
        fakeScore,
      ),
    );
    expect(reEdu.length).toBe(2);
    expect(reEdu.map((e) => [e.institution, e.degree, e.end_date])).toEqual([
      ["MIT", "M.S.", "May 2022"],
      ["Stanford University", "B.S.", "May 2020"],
    ]);
  });
});

/**
 * A coursework bullet immediately followed by a hint-less institution's own
 * lead line (#882 review, PR #889).
 *
 * `isCourseworkContinuation`'s wrapped-continuation absorb (education.ts) rejects
 * `DEGREE_RE`/`INSTITUTION_HINTS`/date-only/acronym lines, but a Title-case,
 * hint-less, non-acronym school name — "Georgia Tech" — trips none of those, so
 * it read as a wrapped continuation of the coursework line and was swallowed
 * whole into the coursework string. The fix declines the absorb whenever the
 * candidate line independently satisfies `isInstitutionLeadAt` — the segmenter's
 * own predicate for exactly this shape (a dated header followed by a degree).
 */
describe("#882 — a coursework bullet does not swallow the next hint-less institution", () => {
  it("keeps `MIT`'s coursework and `Georgia Tech`'s own entry separate", async () => {
    const reEdu = await reparse(
      buildAtsResumeModel(
        makeResult([
          {
            degree: "M.S.",
            field: "Computer Science",
            institution: "MIT",
            end_date: "May 2022",
            coursework: ["Algorithms", "Compilers"],
          },
          {
            degree: "B.S.",
            field: "Computer Science",
            institution: "Georgia Tech",
            end_date: "May 2020",
          },
        ]),
        fakeScore,
      ),
    );
    expect(reEdu.length).toBe(2);
    expect(reEdu.map((e) => [e.institution, e.degree, e.end_date])).toEqual([
      ["MIT", "M.S.", "May 2022"],
      ["Georgia Tech", "B.S.", "May 2020"],
    ]);
    expect(reEdu[0]?.coursework).toEqual(["Algorithms", "Compilers"]);
  });
});

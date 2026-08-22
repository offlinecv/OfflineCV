// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #618 — a graduation date that is a single YEAR ("2023") must get the same
 * right-aligned date slot an Education entry with a range gets, and must round-
 * trip cleanly: re-parse yields the year in the date field with the
 * institution string free of glue. Pre-fix the year was glued after a two-space
 * join onto the header/institution line, and `isLoneDateRange` (the shared
 * discriminator for the parser's column-gap exemption and the exporter's
 * flush-right decision) required TWO date anchors — a lone `2023` returned
 * false. #618 extends that predicate with `{ allowSingle: true }` and applies
 * it at both EXPORTER sites (Education's `rightAlignEduDate`, Experience's
 * `headerLineDate` gate — cited by symbol because the line numbers drift); the
 * parser's `columnGapCuts` deliberately stays range-only. The round-trip works
 * without the parser change because pdfjs emits a synthesized whitespace item
 * spanning the flush-right gap on our own export, so the measured gap is
 * effectively zero and `columnGapCuts` never computes a cut — see the
 * `isLoneDateRange` docblock for the full reasoning (and why extending the
 * parser side caused a wrap-continuation corpus regression).
 *
 * SHAPE NOTE (#882). A degreed entry now leads with the INSTITUTION, so the
 * flush-right slot this test pins moved from `subLineDate` to `headerLineDate`
 * and the degree moved to the sub-line. What #618 owns is unchanged and is what
 * these assertions still check: a lone year is NOT glued after a whitespace gap,
 * it re-parses onto its org line, and two degree-less entries stay two. #882 also
 * retired the `isLoneDateRange` gate this test's docblock describes — the
 * exporter now owns that decision (`educationDateDrawsFlushRight`), while
 * `isLoneDateRange` itself and every parser call site are untouched, exactly as
 * described below.
 *
 * Acceptance coverage (from the issue):
 *   • Model: the year in the flush-right slot, the org line free of it
 *   • Round-trip: `education[0].end_date === "2023"`, institution free of the year
 *   • #302 regression guard: two adjacent degree-less entries each with a lone
 *     year still re-parse as TWO entries (not one)
 *   • Range behaviour on Education is byte-identical to today (control row)
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../heuristics/types.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "../heuristics/sections.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

function makeResult(overrides: Partial<HeuristicParsedResume> = {}): CascadeResult {
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
        education: [],
        projects: [],
        heuristic_achievements: [],
        ...overrides,
      },
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

describe("#618 — degreed entry with a lone graduation year", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    model = buildAtsResumeModel(
      makeResult({
        education: [
          {
            degree: "BS Computer Science",
            institution: "Ridgemont State University",
            year: "2023",
          },
        ],
      }),
      fakeScore,
    );
    reparsed = await runCascade((await renderAtsResumePdf(model)).bytes);
  });

  it("renders `2023` in the flush-right date column — no glue on the org line", () => {
    const edu = model.sections.find((s) => s.heading === "Education");
    const entry = edu?.entries[0];
    // The pre-#618 bug: the org line read "Ridgemont State University  2023"
    // (two-space glue). Post-fix: institution alone, year in the flush-right
    // slot — which since #882 is `headerLineDate`, the org line being the header.
    expect(entry?.headerLine).toBe("Ridgemont State University");
    expect(entry?.headerLineDate).toBe("2023");
    expect(entry?.subLine).toBe("BS Computer Science");
  });

  it("re-parses with `end_date === 2023` and the institution free of the year", () => {
    const reEdu = reparsed.canonical.fields.education ?? [];
    expect(reEdu.length).toBe(1);
    expect(reEdu[0]?.end_date ?? reEdu[0]?.year).toBe("2023");
    // The institution string must NOT carry a glued "2023" tail.
    expect(reEdu[0]?.institution).toBe("Ridgemont State University");
    expect(reEdu[0]?.institution).not.toMatch(/2023/);
  });
});

describe("#618 — degree-less program with a lone graduation year", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;

  beforeAll(async () => {
    model = buildAtsResumeModel(
      makeResult({
        education: [
          {
            degree: "",
            field: "Certificate Program in Applied Analytics",
            institution: "Ridgemont State University",
            year: "2023",
          },
        ],
      }),
      fakeScore,
    );
  });

  it("renders `2023` as flush-right `headerLineDate` on the FIELD header (#302 cue preserved)", () => {
    const edu = model.sections.find((s) => s.heading === "Education");
    const entry = edu?.entries[0];
    // #302: the date must stay on the HEADER line for a degree-less entry so
    // the re-parser reads it as an `isInlineDatedProgram` lead (else two
    // degree-less entries collapse to one).
    expect(entry?.headerLine).toBe("Certificate Program in Applied Analytics");
    expect(entry?.headerLineDate).toBe("2023");
    expect(entry?.subLine).toBe("Ridgemont State University");
  });
});

describe("#618 — regression guard for #302 (two degree-less entries stay two)", () => {
  let reparsed: CascadeResult;

  beforeAll(async () => {
    const model = buildAtsResumeModel(
      makeResult({
        education: [
          {
            degree: "",
            field: "Certificate Program in Applied Analytics",
            institution: "Ridgemont State University",
            year: "2023",
          },
          {
            degree: "",
            field: "Bootcamp in Full-Stack Web Development",
            institution: "Lakeside Institute of Technology",
            year: "2020",
          },
        ],
      }),
      fakeScore,
    );
    reparsed = await runCascade((await renderAtsResumePdf(model)).bytes);
  });

  it("re-parses BOTH degree-less entries as SEPARATE entries, not one merged", () => {
    const reEdu = reparsed.canonical.fields.education ?? [];
    // The load-bearing #302 assertion: 2 in, 2 out.
    expect(reEdu.length).toBe(2);
    const years = reEdu
      .map((e) => e?.end_date ?? e?.year)
      .sort();
    expect(years).toEqual(["2020", "2023"]);
    // And each institution string is free of any glued year.
    for (const entry of reEdu) {
      expect(entry?.institution).not.toMatch(/20\d{2}/);
    }
  });
});

describe("#618 — control: a range date on Education still round-trips exactly like today", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    model = buildAtsResumeModel(
      makeResult({
        education: [
          {
            degree: "MS Data Science",
            institution: "Ridgemont State University",
            start_date: "2019",
            end_date: "2021",
          },
        ],
      }),
      fakeScore,
    );
    reparsed = await runCascade((await renderAtsResumePdf(model)).bytes);
  });

  it("range: org line free of the date, the date column carries the range (pre-#618 shape)", () => {
    const entry = model.sections.find((s) => s.heading === "Education")?.entries[0];
    expect(entry?.headerLine).toBe("Ridgemont State University");
    expect(entry?.headerLineDate).toBe("2019 – 2021");
    expect(entry?.subLine).toBe("MS Data Science");
  });

  it("range: re-parses back with clean institution + start/end dates preserved", () => {
    const reEdu = reparsed.canonical.fields.education ?? [];
    expect(reEdu.length).toBe(1);
    expect(reEdu[0]?.institution).toBe("Ridgemont State University");
    expect(reEdu[0]?.start_date).toBe("2019");
    expect(reEdu[0]?.end_date).toBe("2021");
  });
});

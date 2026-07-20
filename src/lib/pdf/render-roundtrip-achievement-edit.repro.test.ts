// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip guard for #454 — an inline-edited achievement survives the export.
 *
 * The reconstructed view edits a parsed achievement as three REAL fields (type /
 * title / year, #456). This proves the loop is closed end to end — reconstructed
 * edit → applyOverrides → ats-resume-model → PDF → re-parse yields the EDITED
 * type / title / year, and the edited type is the run the PDF bolds (the
 * emphasis sentinels wrap it, per #452).
 *
 * The last case is the one the old composed-title model (#454, design model (a))
 * got wrong: it re-derived the bold run by re-splitting the recomposed title, so
 * clearing the type promoted the title's first segment to the bold run. With
 * `type` a real field there is nothing to re-split.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { applyOverrides } from "../edit/apply-overrides.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { EMPHASIS_OPEN, EMPHASIS_CLOSE } from "./auto-bold-metrics.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const PARSED: HeuristicParsedResume = {
  full_name: "Jane Candidate",
  email: "jane@example.com",
  phone: "(312) 555-0123",
  location: "Chicago, IL",
  summary: "Platform engineer with a decade of distributed-systems experience.",
  skills: ["TypeScript", "Go", "PostgreSQL"],
  experience: [
    {
      title: "Staff Engineer",
      company: "Acme",
      location: "Chicago, IL",
      start_date: "2021",
      end_date: "2024",
      description:
        "Led migration of legacy auth to OAuth for 50K users\nCut p99 checkout latency by 38%",
    },
  ],
  education: [],
  heuristic_achievements: [
    // Mis-parsed on purpose: the type label is wrong and the year is missing —
    // exactly the correction #454 exists to make possible.
    { type: "Pantent", title: "Bulk catalog editor for large marketplaces" },
  ],
};

const EMPTY_SECTIONS: SectionedResume = {
  byName: new Map() as SectionedResume["byName"],
  accomplishmentSections: ["experience", "projects", "achievements"],
  source: "regex",
};

function makeResult(fields: HeuristicParsedResume): CascadeResult {
  return {
    canonical: { fields, sections: EMPTY_SECTIONS, fieldConfidence: {} },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

describe("#454 — an edited achievement round-trips through the export", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    // The user fixes the type typo, tightens the description, and adds the year.
    const edited = applyOverrides(
      PARSED,
      "",
      EMPTY_SECTIONS,
      {},
      {},
      {},
      [],
      {},
      undefined,
      [],
      {},
      undefined,
      undefined,
      undefined,
      {
        0: {
          type: "Patent",
          title: "Bulk catalog editor for marketplaces",
          year: "2019",
        },
      },
    );
    model = buildAtsResumeModel(makeResult(edited.fields), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("bolds exactly the edited type label, and nothing else", () => {
    const entry = model.sections.find((s) => s.kind === "achievements")!
      .entries[0];
    // Only the EDITED type is wrapped in the emphasis sentinels — the run drawn
    // bold. The title + year ride outside them at regular weight.
    expect(entry.headerLine).toBe(
      `${EMPHASIS_OPEN}Patent${EMPHASIS_CLOSE} · ` +
        "Bulk catalog editor for marketplaces · 2019",
    );
    expect(entry.headerBold).toBe(false);
  });

  it("re-parses the edited type / title / year back off the rendered PDF", () => {
    const achievements = reparsed.canonical.fields.heuristic_achievements ?? [];
    expect(achievements).toHaveLength(1);
    expect(achievements[0].type).toBe("Patent");
    expect(achievements[0].title).toBe("Bulk catalog editor for marketplaces");
    expect(achievements[0].year).toBe("2019");
    // The typo the user fixed is gone from the exported document.
    expect(achievements[0].type).not.toContain("Pantent");
  });

  it("clearing the type bolds the whole header — it does not promote the title's first segment (#456)", async () => {
    // The #454 failure case: with the label modelled as the leading run of a
    // composed title, clearing it left "Deep Learning · NeurIPS 2023", whose
    // leading run re-split as the TYPE — so the PDF bolded "Deep Learning", a
    // label the user never typed. The label is a real field now, so an empty
    // one means exactly that: no bold run.
    const edited = applyOverrides(
      PARSED,
      "",
      EMPTY_SECTIONS,
      {},
      {},
      {},
      [],
      {},
      undefined,
      [],
      {},
      undefined,
      undefined,
      undefined,
      { 0: { type: "", title: "Deep Learning · NeurIPS 2023" } },
    );
    const cleared = buildAtsResumeModel(makeResult(edited.fields), fakeScore);
    const entry = cleared.sections.find((s) => s.kind === "achievements")!
      .entries[0];
    expect(entry.headerLine).not.toContain(EMPHASIS_OPEN);
    expect(entry.headerLine).toBe("Deep Learning · NeurIPS 2023");
    expect(entry.headerBold).toBe(true);
  });
});

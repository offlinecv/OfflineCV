// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip guard for #856 — a deleted PARSED entry must not come back out of
 * the exported PDF.
 *
 * The reconstructed view now removes a parsed role / degree / project /
 * achievement, and the whole point of the fix is the artifact: before it, a
 * phantom entry could be blanked field by field and still shipped, because the
 * Download PDF is built from the canonical fields (`ats-resume-model.ts`) and
 * nothing ever dropped the entry from them. Asserting on the model alone would
 * not close that loop — this renders the real PDF and re-parses it, so the claim
 * is about the document a user would actually send.
 *
 * The surviving neighbours are asserted just as hard: a deletion that took the
 * wrong entry, or renumbered the survivors' edits, would land here too.
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
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const GHOST_ROLE = "Interim Coordinator";
const KEPT_ROLE = "Staff Engineer";
const GHOST_DEGREE = "Certificate of Attendance";
const KEPT_DEGREE = "Bachelor of Science";

const PARSED: HeuristicParsedResume = {
  full_name: "Jane Candidate",
  email: "jane@example.com",
  phone: "(312) 555-0123",
  location: "Chicago, IL",
  summary: "Platform engineer with a decade of distributed-systems experience.",
  skills: ["TypeScript", "Go", "PostgreSQL"],
  experience: [
    // Index 0 is the phantom the parser stitched out of a page break.
    {
      title: GHOST_ROLE,
      company: "Nowhere Holdings",
      start_date: "2015",
      end_date: "2016",
      description: "Attended the weekly sync",
    },
    {
      title: KEPT_ROLE,
      company: "Acme",
      location: "Chicago, IL",
      start_date: "2021",
      end_date: "2024",
      description:
        "Led migration of legacy auth to OAuth for 50K users\nCut p99 checkout latency by 38%",
    },
  ],
  education: [
    { degree: GHOST_DEGREE, institution: "Nowhere Institute", end_date: "2014" },
    {
      degree: KEPT_DEGREE,
      field: "Computer Science",
      institution: "State University",
      end_date: "2015",
    },
  ],
  heuristic_achievements: [
    { type: "Patent", title: "Bulk catalog editor for marketplaces", year: "2019" },
    { type: "Award", title: "Engineering excellence recognition", year: "2022" },
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

// A real render + re-parse, which is fast alone but exceeds the 5s default
// under a coverage-instrumented full-suite run; scoped here rather than
// globally (#360), matching the siblings in this directory.
describe("#856 — a deleted entry stays out of the exported PDF", { timeout: 20000 }, () => {
  let reparsed: CascadeResult;

  beforeAll(async () => {
    // Delete the FIRST entry of each section, and edit the survivor of one of
    // them — the pair that a renumbering bug would silently swap.
    const edited = applyOverrides(
      PARSED,
      "",
      EMPTY_SECTIONS,
      {},
      { 1: { company: "Acme Corp." } },
      {},
      [],
      {},
      undefined,
      [],
      {},
      undefined,
      undefined,
      undefined,
      {},
      {},
      undefined,
      new Set(["experience:0", "education:0", "achievements:0"]),
    );
    const model = buildAtsResumeModel(makeResult(edited.fields), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("drops the deleted role and keeps the survivor's own edit", () => {
    const experience = reparsed.canonical.fields.experience;
    expect(experience.map((e) => e.title)).toEqual([KEPT_ROLE]);
    // The header override filed against parsed index 1 followed ITS role, not
    // the neighbour a splice-first fold would have shifted into that slot.
    expect(experience[0].company).toBe("Acme Corp.");
    expect(reparsed.rawText).not.toContain(GHOST_ROLE);
  });

  it("drops the deleted education entry", () => {
    const education = reparsed.canonical.fields.education;
    expect(education.map((e) => e.degree)).toEqual([KEPT_DEGREE]);
    expect(reparsed.rawText).not.toContain(GHOST_DEGREE);
  });

  it("drops the deleted achievement", () => {
    const achievements = reparsed.canonical.fields.heuristic_achievements ?? [];
    expect(achievements.map((a) => a.title)).toEqual([
      "Engineering excellence recognition",
    ]);
    expect(reparsed.rawText).not.toContain("Bulk catalog editor");
  });

  it("keeps the surviving role's bullets intact", () => {
    const description = reparsed.canonical.fields.experience[0].description ?? "";
    expect(description).toContain("OAuth for 50K users");
    expect(description).toContain("Cut p99 checkout latency by 38%");
    expect(description).not.toContain("Attended the weekly sync");
  });
});

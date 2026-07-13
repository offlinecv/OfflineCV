// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Round-trip guard for #455 — a user-ADDED achievement (type / description /
 * year fields) survives the export exactly like a parsed-then-edited one (#454).
 *
 * `AddedEntry` carries the type + description split raw (`achievementType` +
 * `title`); `pushAddedEntry` recomposes "type · description" into the pushed
 * achievement's canonical `title` via `joinAchievementTitle` — the same
 * recomposition `applyAchievementOverrides` does for a parsed edit. This proves
 * the loop is closed end to end for the ADD path — reconstructed add →
 * applyOverrides → ats-resume-model → PDF → re-parse yields the same
 * type / description / year, and the type is the run the PDF bolds (#452).
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
  heuristic_achievements: [],
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

describe("#455 — an added achievement round-trips through the export", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    // The user adds an achievement with distinct type / description / year.
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
      [
        {
          id: "added:0",
          section: "achievements",
          achievementType: "Patent",
          title: "Bulk catalog editor for marketplaces",
          year: "2019",
        },
      ],
      {},
    );
    model = buildAtsResumeModel(makeResult(edited.fields), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("composes the added type + description into the canonical title", () => {
    const entry = model.sections.find((s) => s.kind === "achievements")!
      .entries[0];
    // Only the type is wrapped in the emphasis sentinels — the run drawn bold.
    // The description + year ride outside them at regular weight.
    expect(entry.headerLine).toBe(
      `${EMPHASIS_OPEN}Patent${EMPHASIS_CLOSE} · ` +
        "Bulk catalog editor for marketplaces · 2019",
    );
    expect(entry.headerBold).toBe(false);
  });

  it("re-parses the added type / title / year back off the rendered PDF", () => {
    const achievements = reparsed.canonical.fields.heuristic_achievements ?? [];
    expect(achievements).toHaveLength(1);
    expect(achievements[0].type).toBe("Patent");
    expect(achievements[0].title).toBe("Bulk catalog editor for marketplaces");
    expect(achievements[0].year).toBe("2019");
  });
});

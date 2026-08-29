// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip guard for #626 — the reconstructed résumé and the exported PDF
 * must contain the same set of bullets once one has been removed.
 *
 * Before #626 there was no way to remove a bullet outside the WebGPU-gated
 * `SectionRewrite` panel, and clearing a bullet's text to `""` left a ghost
 * `"empty bullet"` row in the reconstructed résumé while `resolveBullets`
 * (`ats-resume-model.ts`) silently dropped it from the export — the two
 * surfaces disagreed with no visible signal.
 *
 * This proves the fix end to end: `removeBullet` (via `applyOverrides`'s
 * `removedBullets` override) strips the bullet from the graded pool, and the
 * SAME `groupBulletsByExperience` call both `ReconstructedRole` (the UI) and
 * `buildAtsResumeModel` (the export) run over that pool independently lands
 * on the identical bullet set for the role — proven by calling it once here,
 * exactly as each surface does, and comparing both outputs.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect } from "vitest";
import { applyOverrides } from "../edit/apply-overrides.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import {
  groupBulletsByExperience,
  toBulletExperience,
} from "../score/group-bullets.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";

const REMOVED_BULLET =
  "Migrated the legacy auth service to OAuth for 50K users.";
const KEPT_BULLET = "Cut p99 checkout latency by 38% via edge caching.";

function makeFixture() {
  const parsed: HeuristicParsedResume = {
    full_name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    skills: ["TypeScript"],
    experience: [
      {
        title: "Staff Engineer",
        company: "Acme",
        location: "Chicago, IL",
        start_date: "2021",
        end_date: "2024",
        description: `${REMOVED_BULLET}\n${KEPT_BULLET}`,
      },
    ],
    education: [],
  };

  const sections: SectionedResume = {
    byName: new Map([
      ["experience", [`• ${REMOVED_BULLET}`, `• ${KEPT_BULLET}`]],
    ]) as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
    sectionHeadings: new Map(),
  } as unknown as SectionedResume;

  const rawText = [
    "Jane Candidate",
    "jane@example.com",
    "(312) 555-0123",
    "",
    "EXPERIENCE",
    "Staff Engineer — Acme",
    `• ${REMOVED_BULLET}`,
    `• ${KEPT_BULLET}`,
  ].join("\n");

  return { parsed, sections, rawText };
}

function makeResult(
  fields: HeuristicParsedResume,
  sections: SectionedResume,
  rawText: string,
): CascadeResult {
  return {
    canonical: { fields, sections, fieldConfidence: {} },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText,
  } as unknown as CascadeResult;
}

// Same reason as the #625 sibling: a real render + re-parse per case is fast
// alone but exceeds the 5s default under a coverage-instrumented full-suite
// `verify` run; scope the timeout here rather than globally (#360).
describe("#626 — removing a bullet agrees across the reconstructed résumé and the export", { timeout: 20000 }, () => {
  it("the initial (pre-remove) pool grades both bullets, attributed to the one role", () => {
    const { parsed, sections, rawText } = makeFixture();
    const score = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: {},
      triggers: [],
      rawText,
      sections,
    });
    expect(score.bullets?.map((b) => b.text)).toEqual([
      REMOVED_BULLET,
      KEPT_BULLET,
    ]);
  });

  it("drops the removed bullet from BOTH the reconstructed résumé grouping and the exported model, and the two agree", () => {
    const { parsed, sections, rawText } = makeFixture();
    const score1 = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: {},
      triggers: [],
      rawText,
      sections,
    });
    const observations = score1.bullets ?? [];
    const removedId = observations.find((b) => b.text === REMOVED_BULLET)!.id;

    // Fold the removal through the real edit pipeline — the same path
    // `useEditableParse.removeBullet` drives via `applyOverrides`.
    const edited = applyOverrides(
      {
        parsed,
        rawText,
        sections,
        observations,
      },
      {
        skillsOverride: { removed: [], added: [] },
        removedBullets: [removedId],
      },
    );

    // The removed line is gone from BOTH the rawText pool and the role's own
    // description — the two places the scorer and the export fall back to.
    expect(edited.rawText).not.toContain(REMOVED_BULLET);
    expect(edited.rawText).toContain(KEPT_BULLET);
    expect(edited.fields.experience[0].description).not.toContain(
      REMOVED_BULLET,
    );
    expect(edited.fields.experience[0].description).toContain(KEPT_BULLET);

    // Re-grade the edited state, exactly as `useAnalyzedResume` does after an
    // edit — this is the pool BOTH surfaces below consume.
    const score2 = computeAnonymousAtsScore({
      parsed: edited.fields,
      fieldConfidence: edited.fieldConfidence,
      triggers: [],
      rawText: edited.rawText,
      sections: edited.sections,
    });
    const pool = score2.bullets ?? [];
    expect(pool.map((b) => b.text)).toEqual([KEPT_BULLET]);

    // The reconstructed résumé's own grouping call (mirrors `RoleEntry`'s
    // `group.bullets`).
    const uiGroups = groupBulletsByExperience(
      [...pool],
      toBulletExperience(edited.fields.experience),
    );
    const uiBullets = uiGroups
      .filter((g) => g.experienceIndex === 0)
      .flatMap((g) => g.bullets.map((b) => b.text));

    // The exported model's bullets for the same role (mirrors the Download
    // PDF path — `resolveBullets` inside `buildAtsResumeModel`).
    const model = buildAtsResumeModel(
      makeResult(edited.fields, edited.sections, edited.rawText),
      score2 as AnonymousAtsScore,
    );
    const expSection = model.sections.find((s) => s.kind === "experience")!;
    const exportBullets = expSection.entries[0].bullets;

    // The core AC: both surfaces agree, and neither shows the removed bullet.
    expect(uiBullets).toEqual([KEPT_BULLET]);
    expect(exportBullets).toEqual([KEPT_BULLET]);
    expect(exportBullets).toEqual(uiBullets);
    expect(uiBullets).not.toContain(REMOVED_BULLET);
    expect(exportBullets).not.toContain(REMOVED_BULLET);
  });

  it("removing the role's LAST bullet leaves the role intact (header still exported, zero bullets)", () => {
    const { parsed, sections, rawText } = makeFixture();
    const score1 = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: {},
      triggers: [],
      rawText,
      sections,
    });
    const observations = score1.bullets ?? [];
    const bothIds = observations.map((b) => b.id);

    const edited = applyOverrides(
      {
        parsed,
        rawText,
        sections,
        observations,
      },
      {
        skillsOverride: { removed: [], added: [] },
        removedBullets: [...new Set(bothIds)],
      },
    );

    const score2 = computeAnonymousAtsScore({
      parsed: edited.fields,
      fieldConfidence: edited.fieldConfidence,
      triggers: [],
      rawText: edited.rawText,
      sections: edited.sections,
    });
    expect(score2.bullets ?? []).toHaveLength(0);

    const model = buildAtsResumeModel(
      makeResult(edited.fields, edited.sections, edited.rawText),
      score2 as AnonymousAtsScore,
    );
    // The role entry survives with an empty bullet list — not collapsed or
    // dropped from the export.
    const expSection = model.sections.find((s) => s.kind === "experience")!;
    expect(expSection.entries).toHaveLength(1);
    expect(expSection.entries[0].bullets).toEqual([]);
    expect(expSection.entries[0].headerLine).toContain("Staff Engineer");
  });
});

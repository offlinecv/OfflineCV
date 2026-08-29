// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #647 — removing one bullet and then editing another
 * corrupted a THIRD, untouched bullet on both the reconstructed résumé and the
 * exported PDF.
 *
 * The two sides of the edit pipeline disagreed about what a bullet index means.
 * The UI renders (and keys its writes by) the RE-GRADED pool — `edited.score`,
 * which loses a row the moment a bullet is removed — while `applyOverrides`
 * resolves those same keys against the FROZEN base-parse pool. With A removed,
 * the row the user edits at displayed index 1 is C, but index 1 in the base
 * parse is B: B's text was replaced with C's new text and C was left alone.
 *
 * The assertions below are deliberately stated in terms of VISIBLE BULLET TEXT
 * — which bullets the pool, the role description and the export carry — not in
 * terms of override maps, index arithmetic or how the identity is recovered.
 * #648 has since replaced index keys with stable per-bullet ids, removing this
 * class of aliasing by construction: only the two adapters below
 * (`removeDisplayedBullet` / `editDisplayedBullet`) and `regrade`'s call
 * signature changed, and every `expect` still holds verbatim — which is the
 * evidence that the id rework preserved the point fix's behaviour rather than
 * merely replacing its tests.
 *
 * Like the #637 sibling this drives the REAL `useEditableParse` and folds its
 * state through the REAL `applyOverrides` → `computeAnonymousAtsScore` →
 * `buildAtsResumeModel` chain that `/` runs, because the whole defect lived in
 * the seam between them. Mounted with raw `createRoot`, matching
 * `useEditableParse.test.tsx` (the project has no @testing-library/react).
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { scoreEditedResume } from "../lib/edit/score-edited.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Three bullets under one role. A is removed, C is edited, B is the innocent
 *  bystander the bug destroyed. */
const BULLET_A = "Migrated the legacy auth service to OAuth for 50K users.";
const BULLET_B = "Cut p99 checkout latency by 38% via edge caching.";
const BULLET_C = "Led a team of 6 engineers across two release trains.";
const BULLET_C_EDITED = "Led a team of 9 engineers across three release trains.";

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** One parsed role carrying all three bullets — the pristine parse `/` starts
 *  from, before any edit. */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  const lines = [BULLET_A, BULLET_B, BULLET_C];
  return {
    ...blank,
    rawText: lines.map((b) => `• ${b}`).join("\n"),
    canonical: toCanonicalResume(
      {
        full_name: "Robin Vasquez",
        email: "robin.vasquez@example.com",
        phone: "(312) 555-0123",
        skills: ["typescript"],
        education: [],
        experience: [
          {
            title: "Staff Engineer",
            company: "Northwind Systems",
            start_date: "2020",
            end_date: "2024",
            description: lines.join("\n"),
          },
        ],
      },
      sections(lines.map((b) => `• ${b}`)),
      {},
    ),
  };
}

/** The FROZEN base-parse observation pool (`doneScoreBullets` in
 *  `useAnalyzedResume`) — graded once off the pristine parse and never
 *  re-derived, which is exactly why an index into it goes stale. */
const BASE = baseResult();
const OBSERVATIONS: readonly BulletObservation[] =
  computeAnonymousAtsScore({
    parsed: BASE.canonical.fields,
    fieldConfidence: {},
    triggers: BASE.triggers,
    rawText: BASE.rawText,
    sections: BASE.canonical.sections,
  }).bullets ?? [];

/** Run the exact `/` pipeline over the hook's current override state. */
function regrade(api: EditableParse): {
  /** The RE-GRADED pool — what the reconstructed résumé renders and keys by. */
  pool: readonly BulletObservation[];
  displayed: string[];
  roleDescription: string | undefined;
  /** Every bullet the Download PDF would draw. */
  exportedBullets: string[];
} {
  const base = baseResult();
  const core = applyOverrides(
    {
      parsed: base.canonical.fields,
      rawText: base.rawText,
      sections: base.canonical.sections,
      observations: OBSERVATIONS,
      fieldConfidence: base.canonical.fieldConfidence,
    },
    {
      contactOverrides: api.contactOverrides,
      experienceOverrides: api.experienceOverrides,
      bulletOverrides: api.bulletOverrides,
      educationOverrides: api.educationOverrides,
      skillsOverride: api.skillsOverride,
      addedEntries: api.addedEntries,
      addedBullets: api.addedBullets,
      removedBullets: [...api.removedBullets],
      profileOverrides: api.profileOverrides,
      achievementOverrides: api.achievementOverrides,
      descriptionOverrides: api.descriptionOverrides,
      summaryOverride: api.summaryOverride,
    },
  );
  const score = scoreEditedResume(core, base.triggers, [
    ...Object.keys(api.bulletOverrides),
    ...api.removedBullets,
  ]);
  const display: CascadeResult = {
    ...base,
    canonical: {
      ...base.canonical,
      fields: core.fields,
      fieldConfidence: core.fieldConfidence,
    },
  };
  const model = buildAtsResumeModel(display, score as AnonymousAtsScore);
  const pool = score.bullets ?? [];
  return {
    pool,
    displayed: pool.map((b) => b.text),
    roleDescription: core.fields.experience[0].description,
    exportedBullets: model.sections.flatMap((s) =>
      s.entries.flatMap((e) => e.bullets),
    ),
  };
}

let container: HTMLDivElement;
let root: Root;
let api: EditableParse;

function Probe() {
  api = useEditableParse();
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ── UI adapters ─────────────────────────────────────────────────────────────
// The ONLY places that know how a displayed row maps onto an override key.
// `ReconstructedRole` renders `group.bullets` (the re-graded pool) and calls
// `onRemoveBullet(b.id, …)` / `onBulletChange(b.id, value, …)`; these mirror
// that exactly, so "the user clicked the Nth row" is expressed once. The bucket
// reference the role also passes is omitted: this fixture's role is PARSED, so
// no `addedBullets` bucket exists to route through (that path is covered by
// `useEditableParse.added-bullet-edit.repro.test.tsx`).

/** Click "Remove bullet" on the row currently rendered at `position`. */
function removeDisplayedBullet(position: number): void {
  const b = regrade(api).pool[position];
  expect(b, `no bullet rendered at position ${position}`).toBeDefined();
  act(() => api.removeBullet(b.id));
}

/** Commit an inline edit on the row currently rendered at `position`. */
function editDisplayedBullet(position: number, next: string): void {
  const b = regrade(api).pool[position];
  expect(b, `no bullet rendered at position ${position}`).toBeDefined();
  act(() => api.setBulletField(b.id, next));
}

describe("remove a bullet, then edit another (#647)", () => {
  it("grades all three bullets before any edit", () => {
    expect(regrade(api).displayed).toEqual([BULLET_A, BULLET_B, BULLET_C]);
  });

  it("edits the bullet the user actually edited, leaving the bystander intact", () => {
    removeDisplayedBullet(0); // A

    // The pool the user now sees: B, then C.
    expect(regrade(api).displayed).toEqual([BULLET_B, BULLET_C]);

    editDisplayedBullet(1, BULLET_C_EDITED); // C, at its NEW displayed position

    const after = regrade(api);

    // The core AC: C changed, B is untouched, A stays removed — on the
    // reconstructed résumé…
    expect(after.displayed).toEqual([BULLET_B, BULLET_C_EDITED]);
    // …in the role description the résumé and the export both fall back to…
    expect(after.roleDescription).toContain(BULLET_B);
    expect(after.roleDescription).toContain(BULLET_C_EDITED);
    expect(after.roleDescription).not.toContain(BULLET_A);
    expect(after.roleDescription).not.toContain(BULLET_C);
    // …and in the downloaded PDF.
    expect(after.exportedBullets).toEqual([BULLET_B, BULLET_C_EDITED]);

    // Stated the other way round, because THIS is what the bug did: B was
    // overwritten with C's new text and C was left as it was.
    expect(after.displayed).toContain(BULLET_B);
    expect(after.exportedBullets).toContain(BULLET_B);
    expect(after.displayed).not.toContain(BULLET_C);
    expect(after.exportedBullets).not.toContain(BULLET_C);
  });

  it("still resolves an edit made BEFORE the removal (the reverse order)", () => {
    // The mirror case, which the pre-#647 index resolution got right — a fix
    // that only re-projects indices against the surviving pool would break it.
    editDisplayedBullet(2, BULLET_C_EDITED); // C, while all three are shown
    expect(regrade(api).displayed).toEqual([
      BULLET_A,
      BULLET_B,
      BULLET_C_EDITED,
    ]);

    removeDisplayedBullet(0); // A

    const after = regrade(api);
    expect(after.displayed).toEqual([BULLET_B, BULLET_C_EDITED]);
    expect(after.exportedBullets).toEqual([BULLET_B, BULLET_C_EDITED]);
    expect(after.roleDescription).not.toContain(BULLET_A);
  });

  it("re-editing the same bullet after a removal keeps resolving to it", () => {
    removeDisplayedBullet(0); // A
    editDisplayedBullet(1, BULLET_C_EDITED); // C
    editDisplayedBullet(1, "Led a team of 12 engineers across four trains.");

    const after = regrade(api);
    expect(after.displayed).toEqual([
      BULLET_B,
      "Led a team of 12 engineers across four trains.",
    ]);
    expect(after.exportedBullets).toEqual(after.displayed);
  });
});

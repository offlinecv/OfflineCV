// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #648 — stable bullet identity through parse → edit →
 * export.
 *
 * Two behaviours the index-keyed override maps could not have, proven against
 * the REAL `useEditableParse` folded through the REAL `applyOverrides` →
 * `computeAnonymousAtsScore` → `buildAtsResumeModel` chain `/` runs:
 *
 *   1. SEQUENTIAL REMOVALS are independent. Remove A, then remove the row now
 *      showing C, and A and C go. Under index keys the second click wrote the
 *      RE-GRADED pool's index — which after the first removal named B — so the
 *      set `{0,1}` dropped A and B and left C standing.
 *
 *   2. A snapshot written BEFORE #648 still replays. Its keys are bare base-pool
 *      indices; `applyOverrides` routes an all-digits key back through the frozen
 *      observations, exactly as the pre-#648 code did.
 *
 * The second suite doubles as the NON-VACUITY PROOF for the first: it drives the
 * identical click sequence through the legacy key space — which IS the pre-#648
 * resolution, still live for migration — and asserts the wrong bullet drops. The
 * two suites differ in nothing but the key space, so the id rework is what
 * separates them.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useEditableParse,
  type EditSnapshot,
  type EditableParse,
} from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import { scoreEditedResume } from "../lib/edit/score-edited.ts";
import {
  computeAnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
 *  `useAnalyzedResume`) — graded once and never re-derived. */
const BASE = baseResult();
const OBSERVATIONS: readonly BulletObservation[] =
  computeAnonymousAtsScore({
    parsed: BASE.canonical.fields,
    fieldConfidence: {},
    triggers: BASE.triggers,
    rawText: BASE.rawText,
    sections: BASE.canonical.sections,
  }).bullets ?? [];

interface Folded {
  pool: readonly BulletObservation[];
  displayed: string[];
  exportedBullets: string[];
}

/** Run the `/` pipeline over an arbitrary pair of override maps. */
function fold(
  bulletOverrides: Record<string, string>,
  removedBullets: ReadonlySet<string>,
): Folded {
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
      bulletOverrides,
      skillsOverride: { removed: [], added: [] },
      removedBullets: [...removedBullets],
    },
  );
  const score = scoreEditedResume(core, base.triggers, [
    ...Object.keys(bulletOverrides),
    ...removedBullets,
  ]);
  const model = buildAtsResumeModel(
    {
      ...base,
      canonical: {
        ...base.canonical,
        fields: core.fields,
        fieldConfidence: core.fieldConfidence,
      },
    },
    score,
  );
  const pool = score.bullets ?? [];
  return {
    pool,
    displayed: pool.map((b) => b.text),
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

/** What the hook's current state folds to. */
function regrade(): Folded {
  return fold(api.bulletOverrides, api.removedBullets);
}

/** Click "Remove bullet" on the row currently rendered at `position`. */
function removeDisplayedBullet(position: number): void {
  const b = regrade().pool[position];
  expect(b, `no bullet rendered at position ${position}`).toBeDefined();
  act(() => api.removeBullet(b.id));
}

describe("sequential removals are independent (#648)", () => {
  it("drops A and C when the user removes A, then the row showing C", () => {
    removeDisplayedBullet(0); // A
    expect(regrade().displayed).toEqual([BULLET_B, BULLET_C]);

    removeDisplayedBullet(1); // C, at its NEW displayed position

    const after = regrade();
    expect(after.displayed).toEqual([BULLET_B]);
    expect(after.exportedBullets).toEqual([BULLET_B]);
    // Two DISTINCT ids recorded — under index keys the second click reused the
    // first's key space and the set collapsed to the wrong pair.
    expect(api.removedBullets.size).toBe(2);
  });

  it("drops all three, one row at a time", () => {
    removeDisplayedBullet(0);
    removeDisplayedBullet(0);
    removeDisplayedBullet(0);
    expect(regrade().displayed).toEqual([]);
    expect(regrade().exportedBullets).toEqual([]);
  });

  it("removes a bullet that was EDITED first, by its current text", () => {
    // The row's id follows its text, so the removal names the edited line — and
    // `applyRemovedBulletOverrides` runs AFTER the text pass, so that line is
    // in the tree by the time it is looked for.
    const c = regrade().pool[2];
    act(() => api.setBulletField(c.id, BULLET_C_EDITED));
    expect(regrade().displayed).toEqual([BULLET_A, BULLET_B, BULLET_C_EDITED]);

    removeDisplayedBullet(2);

    const after = regrade();
    expect(after.displayed).toEqual([BULLET_A, BULLET_B]);
    expect(after.exportedBullets).toEqual([BULLET_A, BULLET_B]);
  });
});

describe("a pre-#648 snapshot still replays (the persisted-schema migration)", () => {
  /** A snapshot as it was written before #648: `bulletOverrides` keyed by
   *  base-pool index, `removedBullets` a `number[]`. This is the literal shape
   *  sitting in a saved-library IndexedDB record and in a localStorage blank
   *  draft today, so it is spelled out rather than produced by the hook. */
  function legacySnapshot(
    over: Record<number, string>,
    removed: number[],
  ): EditSnapshot {
    return {
      contactOverrides: {},
      experienceOverrides: {},
      bulletOverrides: over as Record<string, string>,
      removedBullets: removed,
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [],
      addedBullets: {},
    };
  }

  it("resolves a legacy index-keyed EDIT against the base-parse pool", () => {
    act(() => api.replay(legacySnapshot({ 2: BULLET_C_EDITED }, [])));

    expect(regrade().displayed).toEqual([
      BULLET_A,
      BULLET_B,
      BULLET_C_EDITED,
    ]);
    expect(regrade().exportedBullets).toEqual([
      BULLET_A,
      BULLET_B,
      BULLET_C_EDITED,
    ]);
  });

  it("resolves a legacy index-keyed REMOVAL against the base-parse pool", () => {
    act(() => api.replay(legacySnapshot({}, [0])));
    expect(regrade().displayed).toEqual([BULLET_B, BULLET_C]);
  });

  it("keeps the two key spaces apart within one snapshot", () => {
    // A résumé resumed from a legacy draft and then edited again holds both:
    // the legacy index for the old edit, an id for the new one.
    act(() => api.replay(legacySnapshot({ 0: "Rebuilt auth on OIDC end to end." }, [])));
    const b = regrade().pool[1];
    act(() => api.setBulletField(b.id, "Cut p99 latency 61% with a new cache."));

    expect(regrade().displayed).toEqual([
      "Rebuilt auth on OIDC end to end.",
      "Cut p99 latency 61% with a new cache.",
      BULLET_C,
    ]);
  });

  // ── Non-vacuity: the SAME click sequence in the legacy key space ──
  // The legacy branch IS the pre-#648 resolution, so replaying the sequential
  // removal through it reproduces the defect verbatim. Nothing but the key space
  // differs from the first suite above.
  it("REPRODUCES the old defect when the same clicks are keyed by index", () => {
    // Click 1: remove displayed row 0 → base-pool index 0 (A).
    const afterFirst = fold({}, new Set(["0"]));
    expect(afterFirst.displayed).toEqual([BULLET_B, BULLET_C]);

    // Click 2: remove displayed row 1 — which now renders C, but whose index in
    // the RE-GRADED pool is 1, and index 1 of the FROZEN base pool is B.
    const afterSecond = fold({}, new Set(["0", "1"]));

    expect(afterSecond.displayed).toEqual([BULLET_C]); // ← B died, C survived
    expect(afterSecond.displayed).not.toContain(BULLET_B);
  });
});

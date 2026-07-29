// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #637 half 1 — "Remove bullet" was inert on every
 * user-added bullet.
 *
 * The removal has to be proven end-to-end, not at the hook boundary: the whole
 * defect was that the hook DID record something (`removedBullets`) and nothing
 * downstream could resolve it. So each case drives the REAL `useEditableParse`
 * and then folds its state through the REAL `applyOverrides` →
 * `computeAnonymousAtsScore` → `buildAtsResumeModel` chain that `/` runs, and
 * asserts against all three of the issue's surfaces: the rendered bullet pool,
 * the score, and the exported PDF model.
 *
 * `observations` is the FROZEN base-parse pool (`doneScoreBullets` in
 * `useAnalyzedResume`), deliberately built from the parsed role alone — that
 * asymmetry IS the bug: an added bullet never appears there, so an
 * index-keyed removal could never reach it.
 *
 * Mounted with raw `createRoot`, matching `useEditableParse.test.tsx` (the
 * project has no @testing-library/react).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import { bulletId } from "../lib/score/bullet-id.ts";
import {
  computeAnonymousAtsScore,
  countWords,
  type AnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { projectScoreSections } from "../lib/heuristics/projections.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { batchUndoTargets } from "../lib/rewrite-review/undo-batch.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
const ADDED_BULLET = "Shipped a design system used by 40 engineers.";

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** One PARSED role carrying `PARSED_BULLET`. The added role arrives via the
 *  hook's own `addEntry`, exactly as "+ Add experience" produces it. */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  return {
    ...blank,
    rawText: `• ${PARSED_BULLET}`,
    canonical: toCanonicalResume(
      {
        full_name: "Robin Vasquez",
        email: "robin.vasquez@example.com",
        skills: ["typescript"],
        education: [],
        experience: [
          {
            title: "Staff Engineer",
            company: "Northwind Systems",
            start_date: "2020",
            end_date: "2024",
            description: PARSED_BULLET,
          },
        ],
      },
      sections([`• ${PARSED_BULLET}`]),
      {},
    ),
  };
}

/** The frozen base-parse observation pool — the parsed bullet ONLY. */
const OBSERVATIONS: readonly BulletObservation[] = [
  {
    text: PARSED_BULLET,
    id: bulletId(PARSED_BULLET, 0),
    index: 0,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: countWords(PARSED_BULLET),
  },
];

/** Run the exact `/` pipeline over the hook's current override state. */
function regrade(api: EditableParse): {
  score: AnonymousAtsScore;
  bulletTexts: string[];
  roleDescriptions: (string | undefined)[];
  /** Every bullet the Download PDF would draw, across all entries. */
  exportedBullets: string[];
} {
  const base = baseResult();
  const core = applyOverrides(
    base.canonical.fields,
    base.rawText,
    base.canonical.sections,
    api.contactOverrides,
    api.experienceOverrides,
    api.bulletOverrides,
    OBSERVATIONS,
    api.educationOverrides,
    api.skillsOverride,
    api.addedEntries,
    api.addedBullets,
    api.removedBullets,
    api.profileOverrides,
    base.canonical.fieldConfidence,
    api.achievementOverrides,
    api.descriptionOverrides,
    api.summaryOverride,
  );
  const score = computeAnonymousAtsScore({
    parsed: core.fields,
    fieldConfidence: core.fieldConfidence,
    triggers: base.triggers,
    rawText: core.rawText,
    sections: projectScoreSections(core),
  });
  const display: CascadeResult = {
    ...base,
    canonical: {
      ...base.canonical,
      fields: core.fields,
      fieldConfidence: core.fieldConfidence,
    },
  };
  const model = buildAtsResumeModel(display, score);
  return {
    score,
    bulletTexts: (score.bullets ?? []).map((b) => b.text),
    roleDescriptions: core.fields.experience.map((e) => e.description),
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

/** Add a role via "+ Add experience" and give it one bullet. Returns its id. */
function addRoleWithBullet(): string {
  let id = "";
  act(() => {
    id = api.addEntry("experience");
    api.setEntryField(id, "title", "Principal Engineer");
    api.setEntryField(id, "subtitle", "Cascadia Analytics");
  });
  act(() => api.addBullet(id, ADDED_BULLET));
  return id;
}

/** The added bullet's index in the RE-GRADED pool (never in OBSERVATIONS). */
function addedObsId(): string {
  const at = regrade(api).bulletTexts.indexOf(ADDED_BULLET);
  expect(at).toBeGreaterThanOrEqual(0);
  return regrade(api).score.bullets![at].id;
}

/** The PARSED bullet's own id — the one a wrongly-filed removal would hit. */
const PARSED_ID = bulletId(PARSED_BULLET, 0);
/** An id that names no line anywhere: the stand-in for the stale observation
 *  index these call sites used before #648. */
const STALE_ID = bulletId("no bullet reads like this", 0);

describe("removeBullet on a user-ADDED role (#637 half 1)", () => {
  it("drops the bullet from the pool, the score and the exported PDF", () => {
    const id = addRoleWithBullet();

    const before = regrade(api);
    expect(before.bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);
    expect(before.exportedBullets).toContain(ADDED_BULLET);

    const obsId = addedObsId();
    act(() => api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET }));

    const after = regrade(api);
    // 1. Gone from the rendered/graded bullet pool.
    expect(after.bulletTexts).toEqual([PARSED_BULLET]);
    // 2. Gone from the added role's own description (what the UI renders).
    expect(after.roleDescriptions[1]).toBeUndefined();
    // 3. Gone from the exported PDF model.
    expect(after.exportedBullets).not.toContain(ADDED_BULLET);
    expect(after.exportedBullets).toContain(PARSED_BULLET);
    // 4. The score actually moved — the whole point of "it stays in the score".
    expect(after.score.specificity).not.toEqual(before.score.specificity);
  });

  it("empties the bucket so the now-blank-bodied role is prunable", () => {
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    act(() => api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET }));

    // The bucket is DELETED, not left as `{id: []}` — `hasEdits` and
    // `isAddedEntryEmpty` both key off its presence/length.
    expect(id in api.addedBullets).toBe(false);
  });

  it("restores the bullet through the captured undo", () => {
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    // Exactly the capture-then-write order `useBulletRemoveStatus` performs.
    let undo = () => {};
    act(() => {
      undo = api.captureBulletUndo(
        batchUndoTargets([{ kind: "remove", obsId }], id),
      );
      api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET });
    });
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);

    act(() => undo());

    const restored = regrade(api);
    expect(restored.bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);
    expect(restored.exportedBullets).toContain(ADDED_BULLET);
    expect(api.addedBullets[id]).toEqual([ADDED_BULLET]);
  });

  it("removes each of two added bullets independently, in one tick", () => {
    const id = addRoleWithBullet();
    act(() => api.addBullet(id, "Mentored 6 engineers to promotion."));
    expect(api.addedBullets[id]).toHaveLength(2);

    // Both removes land in ONE act(), so the second reads the ref rather than
    // a committed render — the case a render closure would get wrong.
    act(() => {
      api.removeBullet(STALE_ID, { entryKey: id, text: ADDED_BULLET });
      api.removeBullet(bulletId("Mentored 6 engineers to promotion.", 0), {
        entryKey: id,
        text: "Mentored 6 engineers to promotion.",
      });
    });

    expect(id in api.addedBullets).toBe(false);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);
    // Neither id leaked into the removal-keyed set.
    expect(api.removedBullets.size).toBe(0);
  });

  it("keeps an add made in the SAME tick as a splicing remove", () => {
    // The add-before-remove order `resolveSectionWrites` emits in ordinary pair
    // order, run synchronously by the rewrite-apply loops. A literal
    // `setAddedBullets(next)` in the remove path discards the add's queued
    // update, so `writeAddedBullets` must make the ref — not the committed
    // state — the base every writer composes on.
    const id = addRoleWithBullet();

    act(() => {
      api.addBullet(id, "Cut infra spend 22% by right-sizing clusters.");
      api.removeBullet(STALE_ID, { entryKey: id, text: ADDED_BULLET });
    });

    expect(api.addedBullets[id]).toEqual([
      "Cut infra spend 22% by right-sizing clusters.",
    ]);
    expect(regrade(api).bulletTexts).toEqual([
      PARSED_BULLET,
      "Cut infra spend 22% by right-sizing clusters.",
    ]);
  });

  it("keeps a CROSS-BUCKET add made in the same tick as a splicing remove", () => {
    // The whole-résumé rewrite path applies every section in one synchronous
    // loop, so the add and the remove routinely land on different entries.
    const a = addRoleWithBullet();
    let b = "";
    act(() => {
      b = api.addEntry("experience");
      api.setEntryField(b, "title", "Engineering Manager");
    });

    act(() => {
      api.addBullet(b, "Grew the platform team from 4 to 11.");
      api.removeBullet(STALE_ID, { entryKey: a, text: ADDED_BULLET });
    });

    expect(api.addedBullets[b]).toEqual(["Grew the platform team from 4 to 11."]);
    expect(a in api.addedBullets).toBe(false);
  });

  it("keeps a same-tick add against a PARSED role's bucket", () => {
    // Not confined to added entries: a parsed role's bucket is written by the
    // same pair of setters, so the clobber reached it too.
    act(() => api.addBullet("experience:0", ADDED_BULLET));

    act(() => {
      api.addBullet("experience:0", "Owned the migration to Postgres 16.");
      api.removeBullet(STALE_ID, { entryKey: "experience:0", text: ADDED_BULLET });
    });

    expect(api.addedBullets["experience:0"]).toEqual([
      "Owned the migration to Postgres 16.",
    ]);
    expect(api.removedBullets.size).toBe(0);
  });

  it("never files a removal under another bullet's id for an added entry", () => {
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    act(() => api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET }));
    // A repeat click (the row is already gone) must NOT fall through: filing
    // the PARSED bullet's id there would remove an unrelated bullet.
    act(() => api.removeBullet(PARSED_ID, { entryKey: id, text: ADDED_BULLET }));

    expect(api.removedBullets.size).toBe(0);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);
  });
});

describe("removeBullet still reaches PARSED bullets (#637 scoping)", () => {
  it("falls through to removedBullets for a parsed role's own bullet", () => {
    act(() =>
      api.removeBullet(PARSED_ID, {
        entryKey: "experience:0",
        text: PARSED_BULLET,
      }),
    );

    expect(api.removedBullets.has(PARSED_ID)).toBe(true);
    const after = regrade(api);
    expect(after.bulletTexts).toEqual([]);
    expect(after.exportedBullets).not.toContain(PARSED_BULLET);
  });

  it("removes an ADDED bullet on a PARSED role without touching its parsed one", () => {
    act(() => api.addBullet("experience:0", ADDED_BULLET));
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);

    act(() =>
      api.removeBullet(addedObsId(), {
        entryKey: "experience:0",
        text: ADDED_BULLET,
      }),
    );

    // Spliced from the bucket, NOT filed in `removedBullets` (the added
    // bullet's id names a line that only exists inside that bucket).
    expect(api.removedBullets.size).toBe(0);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);
  });

  it("still works with no ref at all (the 'Other bullets' call path)", () => {
    act(() => api.removeBullet(PARSED_ID));
    expect(api.removedBullets.has(PARSED_ID)).toBe(true);
    expect(regrade(api).bulletTexts).toEqual([]);
  });
});

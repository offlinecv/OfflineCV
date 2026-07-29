// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #657 — editing a bullet on a user-ADDED entry was
 * silently inert.
 *
 * Same root cause #637 fixed for REMOVAL, on the write it did not touch. A
 * bullet override names a line for `applyOverrides` to find-and-replace in
 * rawText / the section pool / the entry description; a user-added bullet is in
 * none of them when that pass runs — `applyAddedEntriesAndBullets` mints its
 * line downstream, out of the `addedBullets` bucket. So the override matched
 * nothing and the row kept its old text on screen, in the score, and in the
 * exported PDF. The fix routes the edit into the bucket
 * (`replaceAddedBulletLine`), the one place the line exists.
 *
 * Proven end-to-end, not at the hook boundary — the defect was precisely that
 * the hook recorded something nothing downstream could resolve. Each case drives
 * the REAL `useEditableParse` and folds its state through the REAL
 * `applyOverrides` → `computeAnonymousAtsScore` → `buildAtsResumeModel` chain
 * `/` runs, asserting on all three surfaces the issue names.
 *
 * The ORDERING case is the one the issue called out as the trap: because the
 * edit lands in the bucket, the bucket keeps reading what the row reads, so a
 * later removal still finds its line. Had the edit been held as an override
 * instead, the fix would have traded an inert edit for an inert removal.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useEditableParse,
  parsedEntryKey,
  type EditableParse,
} from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import { scoreEditedResume } from "../lib/edit/score-edited.ts";
import { bulletId } from "../lib/score/bullet-id.ts";
import {
  countWords,
  type AnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { batchUndoTargets } from "../lib/rewrite-review/undo-batch.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
// Deliberately WEAK (no metric, no action verb, under-length) against a STRONG
// edit, so the re-grade is observable — a swap between two equally-graded lines
// would make the "the score moved" assertion vacuous.
const ADDED_BULLET = "Responsible for the internal component library.";
const EDITED_BULLET = "Shipped a design system adopted by 120 engineers.";

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** One PARSED role carrying `PARSED_BULLET`, plus an empty projects array for
 *  the added-project case. Added entries arrive via the hook's own `addEntry`,
 *  exactly as "+ Add …" produces them. */
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
        projects: [],
        heuristic_achievements: [],
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

/** The FROZEN base-parse observation pool — the parsed bullet ONLY. An added
 *  bullet never appears here, which is the whole asymmetry. */
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
  /** What the reconstructed résumé renders and keys its writes by. */
  pool: readonly BulletObservation[];
  bulletTexts: string[];
  descriptions: (string | undefined)[];
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
  const model = buildAtsResumeModel(display, score);
  const pool = score.bullets ?? [];
  return {
    score,
    pool,
    bulletTexts: pool.map((b) => b.text),
    descriptions: [
      ...core.fields.experience.map((e) => e.description),
      ...(core.fields.projects ?? []).map((p) => p.description),
      ...(core.fields.heuristic_achievements ?? []).map((a) => a.description),
    ],
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

// ── UI adapter ──────────────────────────────────────────────────────────────
// The ONE place that knows how a displayed row maps onto a write. `RoleEntry`
// renders the re-graded pool and calls `onBulletChange(b.id, value, {entryKey,
// text: b.text})` / `onRemoveBullet(b.id, …)`; this mirrors that exactly.

function rowFor(text: string): BulletObservation {
  const row = regrade(api).pool.find((b) => b.text === text);
  expect(row, `no row rendering ${JSON.stringify(text)}`).toBeDefined();
  return row!;
}

/** Commit an inline edit on the row currently rendering `text`, under `entryKey`. */
function editRow(entryKey: string, text: string, next: string): void {
  const row = rowFor(text);
  act(() => api.setBulletField(row.id, next, { entryKey, text: row.text }));
}

/** Click "Remove bullet" on the row currently rendering `text`. */
function removeRow(entryKey: string, text: string): void {
  const row = rowFor(text);
  act(() => api.removeBullet(row.id, { entryKey, text: row.text }));
}

/** "+ Add experience", type a header, "+ Add bullet". Returns the entry id. */
function addRoleWithBullet(): string {
  let id = "";
  act(() => {
    id = api.addEntry("experience");
    api.setEntryField(id, "title", "Principal Engineer");
    api.setEntryField(id, "subtitle", "Vantreon Labs");
  });
  act(() => api.addBullet(id, ADDED_BULLET));
  return id;
}

describe("editing a bullet on a user-ADDED role (#657)", () => {
  it("changes the rendered text, the score and the exported PDF", () => {
    const id = addRoleWithBullet();

    const before = regrade(api);
    expect(before.bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);

    editRow(id, ADDED_BULLET, EDITED_BULLET);

    const after = regrade(api);
    // 1. The rendered/graded bullet pool.
    expect(after.bulletTexts).toEqual([PARSED_BULLET, EDITED_BULLET]);
    // 2. The added role's own description (what the résumé renders).
    expect(after.descriptions).toContain(EDITED_BULLET);
    expect(after.descriptions).not.toContain(ADDED_BULLET);
    // 3. The exported PDF model.
    expect(after.exportedBullets).toContain(EDITED_BULLET);
    expect(after.exportedBullets).not.toContain(ADDED_BULLET);
    // 4. The score actually moved — "it stays in the score" was half the bug.
    expect(after.score.specificity).not.toEqual(before.score.specificity);
  });

  it("writes into the bucket rather than leaving an unresolvable override", () => {
    const id = addRoleWithBullet();
    editRow(id, ADDED_BULLET, EDITED_BULLET);

    expect(api.addedBullets[id]).toEqual([EDITED_BULLET]);
    // An override keyed by the added bullet's id could never be folded by
    // `applyOverrides`, and would keep `hasEdits` true forever.
    expect(api.bulletOverrides).toEqual({});
  });

  it("edits a bullet on an added PROJECT the same way", () => {
    let id = "";
    act(() => {
      id = api.addEntry("projects");
      api.setEntryField(id, "title", "Vantreon Atlas");
    });
    act(() => api.addBullet(id, ADDED_BULLET));

    editRow(id, ADDED_BULLET, EDITED_BULLET);

    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET, EDITED_BULLET]);
    expect(regrade(api).exportedBullets).toContain(EDITED_BULLET);
  });

  it("edits a bullet on an added ACHIEVEMENT the same way", () => {
    let id = "";
    act(() => {
      id = api.addEntry("achievements");
      api.setEntryField(id, "title", "Vantreon Innovation Award");
    });
    act(() => api.addBullet(id, ADDED_BULLET));

    editRow(id, ADDED_BULLET, EDITED_BULLET);

    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET, EDITED_BULLET]);
    expect(regrade(api).exportedBullets).toContain(EDITED_BULLET);
  });

  it("edits an ADDED bullet hanging off a PARSED role", () => {
    const key = parsedEntryKey("experience", 0);
    act(() => api.addBullet(key, ADDED_BULLET));

    editRow(key, ADDED_BULLET, EDITED_BULLET);

    const after = regrade(api);
    expect(after.bulletTexts).toEqual([PARSED_BULLET, EDITED_BULLET]);
    // The parsed sibling under the same entry is untouched, and no override was
    // recorded for the added one.
    expect(after.exportedBullets).toContain(PARSED_BULLET);
    expect(api.bulletOverrides).toEqual({});
  });

  it("restores the prior text through the captured undo", () => {
    const id = addRoleWithBullet();
    const row = rowFor(ADDED_BULLET);

    // Exactly the capture-then-write order the rewrite-apply loops perform.
    let undo = () => {};
    act(() => {
      undo = api.captureBulletUndo(
        batchUndoTargets(
          [{ kind: "replace", obsId: row.id, text: EDITED_BULLET }],
          id,
        ),
      );
      api.setBulletField(row.id, EDITED_BULLET, {
        entryKey: id,
        text: row.text,
      });
    });
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET, EDITED_BULLET]);

    act(() => undo());

    expect(api.addedBullets[id]).toEqual([ADDED_BULLET]);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);
    expect(regrade(api).exportedBullets).toContain(ADDED_BULLET);
  });
});

describe("removing an EDITED added bullet (#657 ordering hazard)", () => {
  it("removes the right line — the splice matches the CURRENT text", () => {
    const id = addRoleWithBullet();
    act(() => api.addBullet(id, "Mentored 6 engineers through promotion."));

    editRow(id, ADDED_BULLET, EDITED_BULLET);
    removeRow(id, EDITED_BULLET);

    const after = regrade(api);
    // The edited line is gone; its SIBLING — the line a stale-text splice would
    // have taken instead — survives.
    expect(after.bulletTexts).toEqual([
      PARSED_BULLET,
      "Mentored 6 engineers through promotion.",
    ]);
    expect(after.exportedBullets).not.toContain(EDITED_BULLET);
    expect(after.exportedBullets).not.toContain(ADDED_BULLET);
    // And it never fell through to the id-keyed removal set, where it would
    // name a line that exists nowhere.
    expect(api.removedBullets.size).toBe(0);
  });
});

describe("parsed-bullet editing is unchanged (#657 scoping)", () => {
  it("still records an override and folds it through applyOverrides", () => {
    const key = parsedEntryKey("experience", 0);
    const edited = "Cut p99 checkout latency by 52% via a rebuilt edge cache.";

    editRow(key, PARSED_BULLET, edited);

    // No bucket line matched, so the write fell through to the override map —
    // the parsed path, untouched.
    expect(Object.values(api.bulletOverrides)).toEqual([edited]);
    const after = regrade(api);
    expect(after.bulletTexts).toEqual([edited]);
    expect(after.exportedBullets).toEqual([edited]);
  });
});

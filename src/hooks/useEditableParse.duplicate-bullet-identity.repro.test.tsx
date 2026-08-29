// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression tests for the three ways a bullet id derived from the MUTATING
 * pool destroyed an edit (#648 review).
 *
 * `bulletId` is `"<occurrence>|<normalised text>"`, and the UI grades the
 * RE-GRADED pool. When the occurrence was re-derived from that pool alone, three
 * ordinary sequences silently lost work:
 *
 *   B1 — edit BOTH of two verbatim-identical bullets to different texts. After
 *        the first edit the survivor's occurrence reset to 0, re-minting the id
 *        the first edit was filed under, so the second edit OVERWROTE it. One
 *        map entry survived; the first replacement vanished from state, and the
 *        screen showed the new text twice while the export showed it once.
 *   B2 — remove BOTH of two identical bullets. Same collision, but into a Set:
 *        `prev.has(id)` was already true, so the second Remove was a no-op that
 *        still rendered a "Removed" confirmation with an inert Undo.
 *   B3 — edit a bullet back to a text it already held (A→B, retype A, A→B). The
 *        third write hit an existing key and overwrote it IN PLACE at its old
 *        insertion position, so the ordered chain came out byte-identical to the
 *        previous step: the row displayed "B" while the résumé, the score pool
 *        and the exported PDF all read "A".
 *
 * The fix is one rule, in `assignBulletIds`: the ordinal is a UNIQUENESS
 * discriminator, allocated around the keys the override + removal maps already
 * hold (`claimedBulletKeys`), not a position in whatever pool is being graded.
 * Every case below therefore asserts DISPLAY, the folded résumé AND the exported
 * PDF model together — the divergence between them is the actual defect.
 *
 * Driven through the REAL `useEditableParse` → `applyOverrides` →
 * `scoreEditedResume` → `buildAtsResumeModel` chain `/` runs, so a regression in
 * any link fails here.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
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

/** The duplicated line. A résumé that repeats a responsibility verbatim across
 *  two roles — or pastes the same bullet twice — is the whole point. */
const DUP = "Owned the release process end to end.";
const TAIL = "Reviewed 40 pull requests per month.";

const ALPHA = "Alpha shipped 12 releases with zero rollbacks.";
const BETA = "Beta shipped 20% faster releases.";
const GAMMA = "Gamma cut release toil by 30 hours a month.";

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

function baseResult(lines: readonly string[]): CascadeResult {
  const blank = buildBlankResult();
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

interface Folded {
  pool: readonly BulletObservation[];
  /** What the reconstructed-resume rows render. */
  displayed: string[];
  /** What the role's description carries — the résumé itself. */
  described: string[];
  /** What "Download PDF" would draw. */
  exportedBullets: string[];
}

/** Run the `/` pipeline over a pair of override maps, against `LINES`. */
function fold(
  lines: readonly string[],
  bulletOverrides: Record<string, string>,
  removedBullets: ReadonlySet<string>,
): Folded {
  const base = baseResult(lines);
  const observations =
    computeAnonymousAtsScore({
      parsed: base.canonical.fields,
      fieldConfidence: {},
      triggers: base.triggers,
      rawText: base.rawText,
      sections: base.canonical.sections,
    }).bullets ?? [];
  const core = applyOverrides(
    {
      parsed: base.canonical.fields,
      rawText: base.rawText,
      sections: base.canonical.sections,
      observations,
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
    described: (core.fields.experience[0].description ?? "")
      .split("\n")
      .filter((l) => l.length > 0),
    exportedBullets: model.sections.flatMap((s) =>
      s.entries.flatMap((e) => e.bullets),
    ),
  };
}

let container: HTMLDivElement;
let root: Root;
let api: EditableParse;
let LINES: readonly string[] = [];

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
  return fold(LINES, api.bulletOverrides, api.removedBullets);
}

/** The row currently rendered at `position` — id included, exactly as
 *  `ResumeBulletRow` receives it. */
function row(position: number): BulletObservation {
  const b = regrade().pool[position];
  expect(b, `no bullet rendered at position ${position}`).toBeDefined();
  return b;
}

/** Commit an inline edit on the row at `position` (ResumeBulletRow.handleCommit). */
function editRow(position: number, value: string): void {
  const id = row(position).id;
  act(() => api.setBulletField(id, value));
}

/** Click "Remove bullet" on the row at `position`, returning what the hook
 *  reported — which is what `useBulletRemoveStatus` keys its strip off. */
function removeRow(position: number): boolean {
  const id = row(position).id;
  let recorded = false;
  act(() => {
    recorded = api.removeBullet(id);
  });
  return recorded;
}

/** Arm the same Undo the per-row Remove / rewrite-review Apply arms. */
function captureUndo(targets: {
  replaced?: string[];
  removed?: string[];
}): () => void {
  return api.captureBulletUndo({
    replaced: targets.replaced ?? [],
    removed: targets.removed ?? [],
  });
}

describe("B1 — both of two identical bullets can be edited (#648)", () => {
  beforeEach(() => {
    LINES = [DUP, DUP, TAIL];
  });

  it("keeps BOTH edits, and display agrees with the export", () => {
    editRow(0, ALPHA);
    // The first edit lands and the twin is still standing.
    expect(regrade().displayed).toEqual([ALPHA, DUP, TAIL]);

    editRow(1, BETA);

    const after = regrade();
    // Two DISTINCT instructions — the second used to overwrite the first.
    expect(Object.keys(api.bulletOverrides)).toHaveLength(2);
    expect(Object.values(api.bulletOverrides)).toEqual([ALPHA, BETA]);
    expect(after.displayed).toEqual([ALPHA, BETA, TAIL]);
    // The three surfaces that used to disagree.
    expect(after.described).toEqual([ALPHA, BETA, TAIL]);
    expect(after.exportedBullets).toEqual([ALPHA, BETA, TAIL]);
  });

  it("survives a THIRD identical line", () => {
    LINES = [DUP, DUP, DUP];
    editRow(0, ALPHA);
    editRow(1, BETA);
    editRow(2, GAMMA);

    const after = regrade();
    expect(after.displayed).toEqual([ALPHA, BETA, GAMMA]);
    expect(after.exportedBullets).toEqual([ALPHA, BETA, GAMMA]);
  });

  it("edits the twins in the OTHER order (second row first)", () => {
    editRow(1, BETA);
    editRow(1, ALPHA);

    const after = regrade();
    // Both replacements land. Which physical line carries which is the
    // first-match tiebreak, and the two source lines were identical — the
    // bounded part of the behaviour `bullet-id.ts` documents.
    expect([...after.displayed].sort()).toEqual([ALPHA, BETA, TAIL].sort());
    expect(after.exportedBullets).toEqual(after.displayed);
  });

  it("undoes the second edit back to the twin, leaving the first alone", () => {
    editRow(0, ALPHA);
    const target = row(1).id;
    const undo = captureUndo({ replaced: [target] });
    act(() => api.setBulletField(target, BETA));
    expect(regrade().displayed).toEqual([ALPHA, BETA, TAIL]);

    act(() => undo());

    const after = regrade();
    expect(after.displayed).toEqual([ALPHA, DUP, TAIL]);
    expect(after.exportedBullets).toEqual([ALPHA, DUP, TAIL]);
    // The first edit is untouched — the snapshot was scoped to one slot.
    expect(Object.keys(api.bulletOverrides)).toHaveLength(1);
  });
});

describe("B2 — both of two identical bullets can be removed (#648)", () => {
  beforeEach(() => {
    LINES = [DUP, DUP, TAIL];
  });

  it("drops both, and reports both writes as recorded", () => {
    expect(removeRow(0)).toBe(true);
    expect(regrade().displayed).toEqual([DUP, TAIL]);

    // The survivor: under the old ids this re-minted the first removal's key,
    // `prev.has(id)` was true, and the Set came back unchanged.
    expect(removeRow(0)).toBe(true);

    const after = regrade();
    expect(api.removedBullets.size).toBe(2);
    expect(after.displayed).toEqual([TAIL]);
    expect(after.described).toEqual([TAIL]);
    expect(after.exportedBullets).toEqual([TAIL]);
  });

  it("reports a re-removal of the SAME id as not recorded", () => {
    // What the confirmation strip needs: a write that changed nothing must not
    // render "Removed · Undo" over an unchanged slot.
    const id = row(0).id;
    let first = false;
    let second = false;
    act(() => {
      first = api.removeBullet(id);
    });
    act(() => {
      second = api.removeBullet(id);
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(api.removedBullets.size).toBe(1);
  });

  it("undoes the second removal without resurrecting the first", () => {
    removeRow(0);
    const target = row(0).id;
    const undo = captureUndo({ removed: [target] });
    act(() => api.removeBullet(target));
    expect(regrade().displayed).toEqual([TAIL]);

    act(() => undo());

    const after = regrade();
    // The undo restores exactly one line — it used to restore nothing, because
    // `captureBulletUndoSnapshot` filters an ALREADY-removed id out of
    // `restore` and the colliding id looked already-removed.
    expect(after.displayed).toEqual([DUP, TAIL]);
    expect(after.exportedBullets).toEqual([DUP, TAIL]);
    expect(api.removedBullets.size).toBe(1);
  });

  it("removes one twin and edits the other", () => {
    removeRow(0);
    editRow(0, ALPHA);

    const after = regrade();
    expect(after.displayed).toEqual([ALPHA, TAIL]);
    expect(after.exportedBullets).toEqual([ALPHA, TAIL]);
  });
});

describe("the rewrite-review BATCH path over duplicates (#648 constraint)", () => {
  beforeEach(() => {
    LINES = [DUP, DUP, TAIL];
  });

  // A batch resolves EVERY write against ONE pre-batch pool snapshot — its
  // removal positions live in a single coordinate space and are never
  // sequentially re-indexed (`resolveSectionWrites`). That is safe precisely
  // because `assignBulletIds` hands each row of that one grade a distinct id
  // AND allocates around the keys already claimed, so no two writes in a batch
  // can share a key.
  it("removes both duplicates in one pass, and undoes both", () => {
    const ids = regrade().pool.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length); // distinct within one grade

    const writes = [
      { kind: "remove" as const, obsId: ids[0] },
      { kind: "remove" as const, obsId: ids[1] },
    ];
    const undo = api.captureBulletUndo({
      replaced: [],
      removed: writes.map((w) => w.obsId),
    });
    act(() => {
      for (const w of writes) api.removeBullet(w.obsId);
    });

    expect(regrade().displayed).toEqual([TAIL]);
    expect(regrade().exportedBullets).toEqual([TAIL]);

    act(() => undo());
    expect(regrade().displayed).toEqual([DUP, DUP, TAIL]);
  });

  it("replaces both duplicates in one pass, and undoes both", () => {
    const ids = regrade().pool.map((b) => b.id);
    const undo = api.captureBulletUndo({
      replaced: [ids[0], ids[1]],
      removed: [],
    });
    act(() => {
      api.setBulletField(ids[0], ALPHA);
      api.setBulletField(ids[1], BETA);
    });

    expect(regrade().displayed).toEqual([ALPHA, BETA, TAIL]);
    expect(regrade().exportedBullets).toEqual([ALPHA, BETA, TAIL]);

    act(() => undo());
    expect(regrade().displayed).toEqual([DUP, DUP, TAIL]);
    expect(api.bulletOverrides).toEqual({});
  });
});

describe("B3 — re-editing a bullet back to a text it already held (#648)", () => {
  beforeEach(() => {
    LINES = [DUP, TAIL];
  });

  it("keeps the 3-step cycle A→B, retype A, A→B in sync", () => {
    editRow(0, ALPHA);
    expect(regrade().displayed[0]).toBe(ALPHA);

    editRow(0, DUP); // the user retypes the original text
    expect(regrade().displayed[0]).toBe(DUP);

    editRow(0, ALPHA); // …and re-applies the same edit

    const after = regrade();
    // Under a re-derived ordinal the third write landed on the FIRST key, in
    // place, so the map was byte-identical to step 2 and every surface below
    // still read the original line while the row displayed the edit.
    expect(after.displayed).toEqual([ALPHA, TAIL]);
    expect(after.described).toEqual([ALPHA, TAIL]);
    expect(after.exportedBullets).toEqual([ALPHA, TAIL]);
  });

  it("keeps the 5-step cycle A→B→C→B→C in sync", () => {
    for (const next of [ALPHA, BETA, ALPHA, BETA]) editRow(0, next);

    const after = regrade();
    expect(after.displayed).toEqual([BETA, TAIL]);
    expect(after.described).toEqual([BETA, TAIL]);
    expect(after.exportedBullets).toEqual([BETA, TAIL]);
  });

  it("survives a longer A→B→C→B→C→A walk", () => {
    for (const next of [ALPHA, BETA, GAMMA, BETA, GAMMA, ALPHA])
      editRow(0, next);

    const after = regrade();
    expect(after.displayed).toEqual([ALPHA, TAIL]);
    expect(after.exportedBullets).toEqual([ALPHA, TAIL]);
  });

  it("undoes the last leg of a cycle back to the previous text", () => {
    editRow(0, ALPHA);
    editRow(0, DUP);
    const target = row(0).id;
    const undo = captureUndo({ replaced: [target] });
    act(() => api.setBulletField(target, ALPHA));
    expect(regrade().displayed[0]).toBe(ALPHA);

    act(() => undo());

    const after = regrade();
    expect(after.displayed).toEqual([DUP, TAIL]);
    expect(after.exportedBullets).toEqual([DUP, TAIL]);
  });

  it("removes a bullet that has been round-tripped through a cycle", () => {
    for (const next of [ALPHA, DUP, ALPHA]) editRow(0, next);
    expect(removeRow(0)).toBe(true);

    const after = regrade();
    expect(after.displayed).toEqual([TAIL]);
    expect(after.exportedBullets).toEqual([TAIL]);
  });
});

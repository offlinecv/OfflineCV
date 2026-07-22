// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for the single-level rewrite-batch undo (issue 510).
 *
 * The thing that must not rot: an undone batch leaves the edit state — and
 * therefore the export — byte-identical to a batch that was never applied. So
 * the store below is not a loose stub; it reimplements `useEditableParse`'s
 * bullet write semantics exactly (blank adds dropped, `removeBullet`
 * idempotent, `undefined` deletes an override, an emptied added-bullet bucket
 * deleted rather than left as `[]`). A divergence there would make these tests
 * pass against a fiction.
 */

import { describe, it, expect } from "vitest";
import {
  batchUndoTargets,
  captureBulletUndoSnapshot,
  restoreBulletUndoSnapshot,
  type BulletEditReadModel,
  type BulletUndoWriter,
} from "./undo-batch.ts";
import type { ResolvedWrite } from "./apply-accepted.ts";
import { applyOverrides } from "../edit/apply-overrides.ts";
import type { BulletObservation } from "../score/score.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";

/** In-memory mirror of the bullet slice of `useEditableParse`. */
class EditStore implements BulletEditReadModel, BulletUndoWriter {
  bulletOverrides: Record<number, string> = {};
  removedBullets: Set<number> = new Set();
  addedBullets: Record<string, string[]> = {};

  // ── forward writes (what an Apply issues) ──
  setBulletField = (index: number, value: string | undefined) => {
    if (value === undefined) delete this.bulletOverrides[index];
    else this.bulletOverrides[index] = value;
  };
  removeBullet = (index: number) => {
    this.removedBullets.add(index);
  };
  addBullet = (entryKey: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.addedBullets[entryKey] = [...(this.addedBullets[entryKey] ?? []), trimmed];
  };

  // ── inverse writes ──
  restoreBullet = (index: number) => {
    this.removedBullets.delete(index);
  };
  setAddedBullets = (entryKey: string, bullets: readonly string[]) => {
    if (bullets.length === 0) delete this.addedBullets[entryKey];
    else this.addedBullets[entryKey] = [...bullets];
  };

  /** A structurally comparable copy — `Set` doesn't deep-equal usefully. */
  freeze() {
    return {
      bulletOverrides: { ...this.bulletOverrides },
      removedBullets: [...this.removedBullets].sort((a, b) => a - b),
      addedBullets: JSON.parse(JSON.stringify(this.addedBullets)) as Record<
        string,
        string[]
      >,
    };
  }

  /** Dispatch one section's writes the way both apply surfaces do. */
  apply(entryKey: string, writes: readonly ResolvedWrite[]) {
    for (const w of writes) {
      if (w.kind === "add") this.addBullet(entryKey, w.text);
      else if (w.kind === "replace") this.setBulletField(w.obsIndex, w.text);
      else this.removeBullet(w.obsIndex);
    }
  }
}

/** Capture → apply → return the undo thunk, the exact order both callers use. */
function applyWithUndo(
  store: EditStore,
  entryKey: string,
  writes: readonly ResolvedWrite[],
): () => void {
  const snap = captureBulletUndoSnapshot(batchUndoTargets(writes, entryKey), store);
  store.apply(entryKey, writes);
  return () => restoreBulletUndoSnapshot(snap, store);
}

describe("batchUndoTargets", () => {
  it("splits writes into replaced / removed slots", () => {
    const targets = batchUndoTargets(
      [
        { kind: "replace", obsIndex: 3, text: "a" },
        { kind: "remove", obsIndex: 7 },
        { kind: "replace", obsIndex: 4, text: "b" },
      ],
      "experience:0",
    );
    expect(targets.replaced).toEqual([3, 4]);
    expect(targets.removed).toEqual([7]);
  });

  it("records the added-bullet entry key only when the batch adds", () => {
    expect(
      batchUndoTargets([{ kind: "remove", obsIndex: 1 }], "experience:0")
        .addedEntryKey,
    ).toBeUndefined();
    expect(
      batchUndoTargets([{ kind: "add", text: "new" }], "experience:0")
        .addedEntryKey,
    ).toBe("experience:0");
  });
});

describe("undo of an applied batch", () => {
  it("restores every touched slot to its exact pre-apply value", () => {
    const store = new EditStore();
    // Pre-existing edit state the batch must not disturb or lose.
    store.setBulletField(1, "hand-edited bullet one");
    store.setBulletField(9, "an untouched bullet");
    store.removeBullet(5); // already removed BEFORE the batch
    store.addBullet("experience:0", "hand-added");
    store.addBullet("experience:0", "hand-added"); // duplicate text on purpose
    const before = store.freeze();

    const undo = applyWithUndo(store, "experience:0", [
      { kind: "replace", obsIndex: 1, text: "rewritten one" }, // over an override
      { kind: "replace", obsIndex: 2, text: "rewritten two" }, // no prior override
      { kind: "remove", obsIndex: 4 }, // newly removed
      { kind: "remove", obsIndex: 5 }, // already removed — a no-op
      { kind: "add", text: "hand-added" }, // same text as an existing add
    ]);

    // The batch really landed.
    expect(store.bulletOverrides[1]).toBe("rewritten one");
    expect(store.bulletOverrides[2]).toBe("rewritten two");
    expect(store.removedBullets.has(4)).toBe(true);
    expect(store.addedBullets["experience:0"]).toHaveLength(3);

    undo();

    expect(store.freeze()).toEqual(before);
    // The specific traps: a bullet with no prior override is DELETED, not
    // blanked; a pre-batch removal survives the undo.
    expect(2 in store.bulletOverrides).toBe(false);
    expect(store.removedBullets.has(5)).toBe(true);
    expect(store.removedBullets.has(4)).toBe(false);
  });

  it("clears the added-bullet bucket rather than leaving an empty array", () => {
    const store = new EditStore();
    const undo = applyWithUndo(store, "experience:2", [
      { kind: "add", text: "only added bullet" },
    ]);
    expect(store.addedBullets["experience:2"]).toEqual(["only added bullet"]);
    undo();
    // `hasEdits` keys off Object.keys(addedBullets).length — a leftover `[]`
    // would leave the résumé permanently dirty after an undo.
    expect(Object.keys(store.addedBullets)).toEqual([]);
  });

  it("is idempotent — replaying the restore changes nothing", () => {
    const store = new EditStore();
    store.setBulletField(1, "original");
    const before = store.freeze();
    const undo = applyWithUndo(store, "experience:0", [
      { kind: "replace", obsIndex: 1, text: "rewritten" },
      { kind: "remove", obsIndex: 3 },
      { kind: "add", text: "added" },
    ]);
    undo();
    undo();
    expect(store.freeze()).toEqual(before);
  });

  it("reverses a MULTI-SECTION batch as one action", () => {
    const store = new EditStore();
    store.setBulletField(0, "role A bullet, hand-edited");
    store.addBullet("experience:1", "role B pre-existing add");
    const before = store.freeze();

    // Two sections, captured before their own writes, undone together — the
    // shape `ResumeRewriteProposed` builds for the whole-résumé apply.
    const undos = [
      applyWithUndo(store, "experience:0", [
        { kind: "replace", obsIndex: 0, text: "A rewritten" },
        { kind: "add", text: "A new bullet" },
      ]),
      applyWithUndo(store, "experience:1", [
        { kind: "remove", obsIndex: 10 },
        { kind: "replace", obsIndex: 11, text: "B rewritten" },
      ]),
    ];
    expect(store.freeze()).not.toEqual(before);

    for (const undo of undos) undo();
    expect(store.freeze()).toEqual(before);
  });
});

// ── Export invariant ────────────────────────────────────────────────────────

function obs(index: number, text: string): BulletObservation {
  return {
    text,
    index,
    hasMetric: false,
    startsWithActionVerb: false,
    wellFormedLength: false,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Dana Ruiz",
    email: "dana@example.com",
    phone: "(312) 555-0123",
    skills: ["typescript"],
    experience: [
      {
        title: "Engineer",
        company: "Acme",
        start_date: "2020",
        end_date: "2022",
        description: "Built a thing\nShipped another thing",
      },
    ],
    education: [],
  };
}

function makeSections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

describe("an undone batch exports identically to one never applied", () => {
  it("folds to the same parse through applyOverrides", () => {
    const rawText = "• Built a thing\n• Shipped another thing";
    const observations = [obs(0, "Built a thing"), obs(1, "Shipped another thing")];
    const sections = makeSections(["• Built a thing", "• Shipped another thing"]);
    const fold = (store: EditStore) =>
      applyOverrides(
        baseParsed(),
        rawText,
        sections,
        {},
        {},
        store.bulletOverrides,
        observations,
        {},
        undefined,
        [],
        store.addedBullets,
        store.removedBullets,
      );

    const store = new EditStore();
    store.setBulletField(0, "Built a thing, carefully");
    const neverApplied = fold(store);

    const undo = applyWithUndo(store, "experience:0", [
      { kind: "replace", obsIndex: 0, text: "Drove a 30% lift in throughput" },
      { kind: "remove", obsIndex: 1 },
      { kind: "add", text: "Owned the migration end to end" },
    ]);
    // Sanity: the applied batch really does change the exported parse, so the
    // equality below is not vacuously true.
    expect(fold(store)).not.toEqual(neverApplied);

    undo();
    expect(fold(store)).toEqual(neverApplied);
  });
});

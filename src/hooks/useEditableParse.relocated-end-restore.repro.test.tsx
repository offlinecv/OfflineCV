// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression for #819 — a restore forgets the #814 parking.
 *
 * `useEditableParse.date-slot-sequence.repro.test.tsx` pins the #814 rule
 * itself: park a date the one-anchor rule relocates out of an End cell, hand
 * it back to `end_date` when a real start date arrives, all inside ONE hook
 * instance. That memory (`relocatedEndsRef`) lived only in a ref, so it never
 * survived a `replay()` — and BOTH restore paths in the app go through
 * `replay()`: `resumeDraft` (`useAnalyzedResume.ts`) for a resumed
 * localStorage draft, and the reset-and-replay effect for a résumé reloaded
 * from the library. This file drives the REAL hook across the boundary each
 * path actually crosses — a fresh hook instance standing in for the reload —
 * and asserts the parking survives it.
 *
 * Probe-component harness (the project has no @testing-library/react) — same
 * pattern as the #814/#672 file.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import { DB_NAME, closeDB } from "../lib/storage/index.ts";
import {
  saveResumeToLibrary,
  loadResumeFromLibrary,
} from "../lib/resume-library.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function makeSections(): SectionedResume {
  return {
    byName: new Map() as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

function parsedWithNoDates(): HeuristicParsedResume {
  return {
    full_name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    skills: ["TypeScript"],
    experience: [{ title: "Alpha Analyst", company: "Contoso" }],
    education: [],
  };
}

/** What `ReconstructedResume` renders and hands back on the next commit: the
 *  overrides-APPLIED role, re-derived from the current map. */
function appliedRole(parsed: HeuristicParsedResume, api: EditableParse) {
  const applied = applyOverrides(
    { parsed, rawText: "raw", sections: makeSections(), observations: [] },
    { experienceOverrides: api.experienceOverrides },
  );
  return applied.fields.experience[0];
}

let container: HTMLDivElement;
let root: Root;
let api: EditableParse;

function Probe() {
  api = useEditableParse();
  return null;
}

/** A fresh hook instance — the same thing a page reload gives the app: no
 *  memory of anything the previous instance parked, only whatever `replay`
 *  is handed. */
function mountFreshProbe() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
}

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  mountFreshProbe();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const baseResult = () =>
  ({
    marker: "cascade-base-819",
    triggers: [],
    canonical: {
      fields: {},
      sections: { byName: new Map([["skills", 1]]) },
      fieldConfidence: {},
    },
  }) as unknown as CascadeResult;

const savedResult = () => ({ marker: "cascade-819" }) as unknown as CascadeResult;
const savedScore = () => ({ overall: 72 }) as AnonymousAtsScore;

describe("#819 — a restored draft/library record keeps the #814 parking", () => {
  it("keeps both dates after replaying a snapshot onto a FRESH hook instance (draft path)", () => {
    // Step 1: End typed first on a role the parser found no dates on — the
    // one-anchor rule relocates it into Start, exactly like #814.
    act(() => api.setExperienceField(0, "end_date", "2022", {}));
    const parsed = parsedWithNoDates();
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });
    expect("end_date" in appliedRole(parsed, api)).toBe(false);

    // Round-trip the snapshot through JSON, exactly as `writeBlankDraft` /
    // `readBlankDraft` do for the localStorage draft.
    const persisted = JSON.parse(JSON.stringify(api.snapshot));
    expect(persisted.relocatedEnds).toEqual({ "role:0": "2022" });

    // Step 2: "reload" — a brand-new hook instance, so nothing survives that
    // isn't in the snapshot being replayed.
    act(() => root.unmount());
    container.remove();
    mountFreshProbe();
    act(() => api.replay(persisted));

    // Step 3: the real start date arrives. Before #819 this dropped the 2022.
    act(() => {
      const resolved = appliedRole(parsed, api);
      api.setExperienceField(0, "start_date", "2019", resolved);
    });
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("keeps both dates after a library save/reload (loadResumeFromLibrary → replay)", async () => {
    act(() => api.setExperienceField(0, "end_date", "2022", {}));
    const parsed = parsedWithNoDates();
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });

    const id = await saveResumeToLibrary({
      filename: "cv.pdf",
      sourceKind: "pdf",
      result: savedResult(),
      score: savedScore(),
      baseResult: baseResult(),
      edit: api.snapshot,
    });

    const loaded = await loadResumeFromLibrary(id);
    expect(loaded?.edit).toBeDefined();
    expect(loaded!.edit!.relocatedEnds).toEqual({ "role:0": "2022" });

    // "Reopen from the library" — a fresh hook instance, replayed with the
    // loaded delta, the same way `useAnalyzedResume`'s reset-and-replay
    // effect calls `edit.replay(state.restoredEdit)`.
    act(() => root.unmount());
    container.remove();
    mountFreshProbe();
    act(() => api.replay(loaded!.edit!));

    act(() => {
      const resolved = appliedRole(parsed, api);
      api.setExperienceField(0, "start_date", "2019", resolved);
    });
    expect(appliedRole(parsed, api)).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("remaps an ADDED entry's parking through its freshly-minted id on replay", () => {
    // The exact repro in the issue: "+ Add role" rather than a parsed one, so
    // the parking key is `added:<id>` and the entry's id is re-minted every
    // replay — the key has to move with it.
    // Two separate commits, like the real UI: "+ Add role" renders the entry
    // (so `addedEntriesRef`'s mirror picks it up) BEFORE the End cell is typed
    // into — combining them in one `act()` would skip the parking, the same
    // way `replay` itself deliberately does (see its own docblock).
    let addedId = "";
    act(() => {
      addedId = api.addEntry("experience");
    });
    act(() => {
      api.setEntryField(addedId, "end_date", "2022");
    });
    expect(
      api.addedEntries.find((e) => e.id === addedId),
    ).toMatchObject({ start_date: "2022", end_date: "" });

    const persisted = JSON.parse(JSON.stringify(api.snapshot));
    expect(Object.keys(persisted.relocatedEnds)).toEqual([`added:${addedId}`]);

    act(() => root.unmount());
    container.remove();
    mountFreshProbe();
    // Force the fresh instance's id counter off zero BEFORE replaying, so the
    // replayed entry's re-minted id provably differs from `addedId` — both
    // start a fresh session at "added:0", so without this the two would
    // coincide and a remap bug (e.g. copying `relocatedEnds` verbatim, with no
    // remap at all) would pass by accident.
    act(() => {
      api.addEntry("projects");
    });
    act(() => api.replay(persisted));

    const restored = api.addedEntries.find((e) => e.section === "experience");
    expect(restored).toBeDefined();
    expect(restored!.id).not.toBe(addedId); // a fresh id was minted
    act(() => api.setEntryField(restored!.id, "start_date", "2019"));
    expect(
      api.addedEntries.find((e) => e.id === restored!.id),
    ).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("keeps an ADDED entry's parking when the freshly-minted id is the SAME as the original (no id churn)", () => {
    // A fresh hook instance mints ids from zero, same as the instance being
    // replayed onto did — so with exactly one added entry, the re-minted id
    // is IDENTICAL to the original. The in-place remap this guards against
    // wrote the new value into the very key it was about to delete,
    // destroying the parking on the single most common restore: the first
    // reload of a session with exactly one added entry.
    let addedId = "";
    act(() => {
      addedId = api.addEntry("experience");
    });
    act(() => {
      api.setEntryField(addedId, "end_date", "2022");
    });

    const persisted = JSON.parse(JSON.stringify(api.snapshot));
    expect(Object.keys(persisted.relocatedEnds)).toEqual([`added:${addedId}`]);

    act(() => root.unmount());
    container.remove();
    mountFreshProbe();
    // No id churn before replay — the fresh instance mints "added:0" again.
    act(() => api.replay(persisted));

    const restored = api.addedEntries.find((e) => e.section === "experience");
    expect(restored).toBeDefined();
    expect(restored!.id).toBe(addedId); // same id, proving the self-map case
    act(() => api.setEntryField(restored!.id, "start_date", "2019"));
    expect(
      api.addedEntries.find((e) => e.id === restored!.id),
    ).toMatchObject({
      start_date: "2019",
      end_date: "2022",
    });
  });

  it("keeps both parked ends when a later entry's re-minted id collides with an earlier entry's original id", () => {
    // Two added entries, each parked. Bumping the fresh instance's counter by
    // exactly ONE before replay makes entry A's re-minted id equal entry B's
    // ORIGINAL id — A's destination key is the same as B's still-unprocessed
    // source key. Remapping in place overwrote B's parking with A's value
    // before B was ever read, and then handed A's own new key A's value a
    // second time via B's (by-then-corrupted) read.
    let idA = "";
    let idB = "";
    act(() => {
      idA = api.addEntry("experience");
    });
    act(() => {
      api.setEntryField(idA, "end_date", "2020");
    });
    act(() => {
      idB = api.addEntry("experience");
    });
    act(() => {
      api.setEntryField(idB, "end_date", "2022");
    });

    const persisted = JSON.parse(JSON.stringify(api.snapshot));
    expect(Object.keys(persisted.relocatedEnds).sort()).toEqual(
      [`added:${idA}`, `added:${idB}`].sort(),
    );

    act(() => root.unmount());
    container.remove();
    mountFreshProbe();
    // One throwaway mint before replay so entry A's re-minted id lands
    // exactly on entry B's original id.
    act(() => {
      api.addEntry("projects");
    });
    act(() => api.replay(persisted));

    const restored = api.addedEntries.filter(
      (e) => e.section === "experience",
    );
    expect(restored).toHaveLength(2);
    const [restoredA, restoredB] = restored;
    act(() => api.setEntryField(restoredA.id, "start_date", "2019"));
    act(() => api.setEntryField(restoredB.id, "start_date", "2021"));
    expect(
      api.addedEntries.find((e) => e.id === restoredA.id),
    ).toMatchObject({ start_date: "2019", end_date: "2020" });
    expect(
      api.addedEntries.find((e) => e.id === restoredB.id),
    ).toMatchObject({ start_date: "2021", end_date: "2022" });
  });

  it("resetAll still clears the parking", () => {
    act(() => api.setExperienceField(0, "end_date", "2022", {}));
    expect(api.snapshot.relocatedEnds).toEqual({ "role:0": "2022" });

    act(() => api.resetAll());
    expect(api.snapshot.relocatedEnds).toEqual({});
  });

  it("a snapshot written before #819 (no relocatedEnds key) still replays exactly as today", () => {
    const preExisting819Snapshot = {
      contactOverrides: {},
      experienceOverrides: { 0: { end_date: "2022" } },
      bulletOverrides: {},
      removedBullets: [],
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [],
      addedBullets: {},
      // no `relocatedEnds` key at all — the pre-#819 shape.
    };

    act(() => api.replay(preExisting819Snapshot as never));
    const parsed = parsedWithNoDates();
    // Replay is verbatim (no resolvedEntry) and `applyOverrides` still runs the
    // #672 rule on its output, so this behaves exactly as it did before #819 —
    // no crash on the missing key, and no parking to restore later.
    expect(appliedRole(parsed, api)).toMatchObject({ start_date: "2022" });
    expect(api.snapshot.relocatedEnds).toEqual({});
  });
});

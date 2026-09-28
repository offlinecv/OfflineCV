// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #768 — a résumé restored from the library with a delta (`baseResult` +
 * `EditSnapshot`) lands in an EDITABLE state, not a flattened one.
 *
 * `loadSavedResume`'s `restoredEdit` field rides in the SAME `setState` as the
 * `result` that defines `parseKey` (`useResumeAnalysis.ts`), and
 * `useAnalyzedResume`'s reset effect replays it in the same event the reset
 * runs in — see that effect's docblock for why a same-event `edit.replay()`
 * call from the caller would be wiped instead. These pin that wiring directly
 * at the hook (App.tsx's `hydrateFromLibrary` is the wiring that FEEDS this
 * field from a loaded library record; that plumbing is exercised separately).
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAnalyzedResume, type AnalyzedResume } from "./useAnalyzedResume.ts";
import type { EditSnapshot } from "./useEditableParse.ts";
import { scoreParsedResume } from "../lib/score/score-cascade.ts";
import {
  createProbeRoot,
  parseRileyResume,
} from "./__test-utils__/riley-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let api: AnalyzedResume;
const probe = createProbeRoot();

function Probe() {
  api = useAnalyzedResume();
  return null;
}

afterEach(() => probe.unmount());

describe("useAnalyzedResume — restoring a delta (#768)", () => {
  it("hydrates on the PRISTINE base and replays the delta onto it", async () => {
    const base = await parseRileyResume();
    const score = scoreParsedResume(base);

    const edit: EditSnapshot = {
      contactOverrides: { full_name: "Riley Q. Nakamura" },
      experienceOverrides: { 0: { title: "Principal Engineer" } },
      bulletOverrides: {},
      removedBullets: [],
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [],
      addedBullets: {},
    };

    probe.mount(createElement(Probe));
    act(() =>
      api.loadSavedResume({
        fileName: "riley.md",
        fileSize: 100,
        sourceKind: "markdown",
        result: base,
        score,
        restoredEdit: edit,
      }),
    );

    // Restore keying: the state hydrates on the PRISTINE parse, so `parseKey`
    // (and the id an autosave `adopt` would bind to) is `base`, not a flattened
    // stand-in.
    expect(api.state.phase).toBe("done");
    expect(api.state.phase === "done" && api.state.result).toBe(base);
    expect(api.parseKey).toBe(base);

    // The delta replayed: it is an EDIT on top of the base, visible in `edit`
    // state and folded into what the page shows.
    expect(api.edit.hasEdits).toBe(true);
    expect(api.edit.contactOverrides.full_name).toBe("Riley Q. Nakamura");
    expect(api.edited?.parsed.full_name).toBe("Riley Q. Nakamura");
    expect(api.edited?.parsed.experience[0]?.title).toBe("Principal Engineer");

    // And it is genuinely UNDO-able — the whole point of storing a delta
    // instead of a flattened record.
    act(() => api.edit.setContactField("full_name", undefined));
    expect(api.edited?.parsed.full_name).toBe(base.canonical.fields.full_name);
  });

  it("a record WITHOUT a delta restores exactly as today (no replay, no extra hasEdits)", async () => {
    const base = await parseRileyResume();
    const score = scoreParsedResume(base);

    probe.mount(createElement(Probe));
    act(() =>
      api.loadSavedResume({
        fileName: "riley.md",
        fileSize: 100,
        sourceKind: "markdown",
        result: base,
        score,
      }),
    );

    expect(api.parseKey).toBe(base);
    expect(api.edit.hasEdits).toBe(false);
    // `applyOverrides` always clones (pure and total, even over an empty
    // snapshot), so this is content equality, not the same reference.
    expect(api.edited?.parsed).toEqual(base.canonical.fields);
  });

  it("restore-then-edit keeps the same parseKey (the id an autosave adopts stays bound)", async () => {
    const base = await parseRileyResume();
    const score = scoreParsedResume(base);
    const edit: EditSnapshot = {
      contactOverrides: { full_name: "Riley Q. Nakamura" },
      experienceOverrides: {},
      bulletOverrides: {},
      removedBullets: [],
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [],
      addedBullets: {},
    };

    probe.mount(createElement(Probe));
    act(() =>
      api.loadSavedResume({
        fileName: "riley.md",
        fileSize: 100,
        sourceKind: "markdown",
        result: base,
        score,
        restoredEdit: edit,
      }),
    );
    const keyAfterRestore = api.parseKey;

    // A further edit, exactly as the user resuming a session would make.
    act(() => api.edit.setContactField("location", "Remote"));

    // `parseKey` is unchanged by an edit (by construction — see the hook's own
    // docblock) — the same record an autosave `adopt`ed on restore is still
    // the one a later write would update, never a fresh one.
    expect(api.parseKey).toBe(keyAfterRestore);
    expect(api.parseKey).toBe(base);
  });

  it("survives StrictMode's double effect invocation with no duplicated entries", async () => {
    const base = await parseRileyResume();
    const score = scoreParsedResume(base);
    const edit: EditSnapshot = {
      contactOverrides: { full_name: "Riley Q. Nakamura" },
      experienceOverrides: {},
      bulletOverrides: {},
      removedBullets: [],
      educationOverrides: {},
      skillsOverride: { removed: [], added: [] },
      addedEntries: [
        { id: "added:0", section: "experience", title: "Contract Engineer", subtitle: "Globex" },
      ],
      addedBullets: { "added:0": ["Shipped a thing."] },
      profileOverrides: [
        { id: "profile:0", url: "https://github.com/riley", network: "github", kind: "code" },
      ],
    };

    let container: HTMLDivElement | null = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = createRoot(container);
    act(() =>
      root!.render(createElement(StrictMode, null, createElement(Probe))),
    );
    act(() =>
      api.loadSavedResume({
        fileName: "riley.md",
        fileSize: 100,
        sourceKind: "markdown",
        result: base,
        score,
        restoredEdit: edit,
      }),
    );

    // Exactly one of each — a double replay (reset → replay → reset → replay)
    // must not leave two copies behind.
    expect(api.edit.addedEntries).toHaveLength(1);
    expect(api.edit.profileOverrides).toHaveLength(1);
    // The base résumé's own 2 parsed roles, plus exactly ONE added one.
    expect(api.edited?.parsed.experience).toHaveLength(3);
    const added = api.edited?.parsed.experience.find(
      (e) => e.title === "Contract Engineer",
    );
    expect(added).toBeDefined();
    const addedRoleKey = api.edit.addedEntries[0]!.id;
    expect(api.edit.addedBullets[addedRoleKey]).toEqual(["Shipped a thing."]);
    expect(api.edited?.parsed.full_name).toBe("Riley Q. Nakamura");

    act(() => root!.unmount());
    container.remove();
    container = null;
    root = null;
  });
});

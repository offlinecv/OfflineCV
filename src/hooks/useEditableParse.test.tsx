// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Tests for the empty-added-entry pruning that backs #379 — a "+ Add …" entry
 * the user opens and abandons without typing must not persist.
 *
 * `isAddedEntryEmpty` is pure and tested directly. `pruneEmptyAddedEntries` is
 * exercised through a probe component (the project has no
 * @testing-library/react — same pattern as `useAnalyzedResume.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useEditableParse,
  isAddedEntryEmpty,
  type EditableParse,
  type AddedEntry,
} from "./useEditableParse.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("isAddedEntryEmpty", () => {
  const base: AddedEntry = { id: "added:0", section: "education", title: "" };

  it("is true for a freshly-added, untouched entry with no bullets", () => {
    expect(isAddedEntryEmpty(base, {})).toBe(true);
  });

  it("treats whitespace-only header fields as empty", () => {
    expect(isAddedEntryEmpty({ ...base, title: "   ", subtitle: "\t" }, {})).toBe(
      true,
    );
  });

  it("is false when any header field carries content", () => {
    expect(isAddedEntryEmpty({ ...base, title: "BSc CS" }, {})).toBe(false);
    expect(isAddedEntryEmpty({ ...base, subtitle: "State U" }, {})).toBe(false);
    expect(isAddedEntryEmpty({ ...base, start_date: "2019" }, {})).toBe(false);
  });

  it("is false when the entry has appended bullets, even with a blank header", () => {
    expect(isAddedEntryEmpty(base, { "added:0": ["Did a thing"] })).toBe(false);
  });
});

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

describe("useEditableParse — pruneEmptyAddedEntries (#379)", () => {
  it("drops a blank added entry in the target section", () => {
    let id = "";
    act(() => {
      id = api.addEntry("education");
    });
    expect(api.addedEntries).toHaveLength(1);

    act(() => api.pruneEmptyAddedEntries("education"));
    expect(api.addedEntries).toHaveLength(0);
    expect(id).toMatch(/^added:/);
  });

  it("keeps an entry that has any populated field", () => {
    let id = "";
    act(() => {
      id = api.addEntry("education");
      api.setEntryField(id, "title", "BSc CS");
    });

    act(() => api.pruneEmptyAddedEntries("education"));
    expect(api.addedEntries).toHaveLength(1);
    expect(api.addedEntries[0].title).toBe("BSc CS");
  });

  it("keeps a blank entry that has appended bullets", () => {
    let id = "";
    act(() => {
      id = api.addEntry("experience");
      api.addBullet(id, "Shipped a feature");
    });

    act(() => api.pruneEmptyAddedEntries("experience"));
    expect(api.addedEntries).toHaveLength(1);
  });

  it("prunes only the named section, leaving a fresh entry in another section", () => {
    act(() => {
      api.addEntry("education");
      api.addEntry("experience");
    });
    expect(api.addedEntries).toHaveLength(2);

    // Leaving Education must not nuke the just-added (still-blank) Experience one.
    act(() => api.pruneEmptyAddedEntries("education"));
    expect(api.addedEntries.map((e) => e.section)).toEqual(["experience"]);
  });

  it("is a no-op (stable identity) when nothing is empty", () => {
    act(() => {
      const id = api.addEntry("projects");
      api.setEntryField(id, "title", "Portfolio site");
    });
    const before = api.addedEntries;

    act(() => api.pruneEmptyAddedEntries("projects"));
    expect(api.addedEntries).toBe(before);
  });
});

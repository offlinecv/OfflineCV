// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
import type { SkillCategory } from "../lib/heuristics/types.ts";
import { computeEditedSkills } from "../lib/edit/skills-categories.ts";

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

describe("useEditableParse — Skills category edits (#476)", () => {
  const cats: SkillCategory[] = [
    { label: "Frontend", skills: ["React", "TypeScript"] },
    { label: "Backend", skills: ["Java"] },
  ];

  it("takes a grouping snapshot on the first category edit and marks hasEdits", () => {
    expect(api.skillsOverride.categories).toBeUndefined();
    expect(api.hasEdits).toBe(false);

    act(() => api.renameSkillCategory(cats, 0, "UI"));
    expect(api.skillsOverride.categories?.[0].label).toBe("UI");
    // Rename is label-only — members untouched.
    expect(api.skillsOverride.categories?.[0].skills).toEqual(["React", "TypeScript"]);
    expect(api.hasEdits).toBe(true);
  });

  it("moves a skill through the same path the DnD drop uses", () => {
    act(() => api.moveSkillToCategory(cats, "React", 1));
    const snap = api.skillsOverride.categories!;
    expect(snap[0].skills).toEqual(["TypeScript"]);
    expect(snap[1].skills).toContain("React");
  });

  it("resetAll clears the category snapshot back to pristine", () => {
    act(() => api.addSkillCategory(cats, "Data"));
    expect(api.skillsOverride.categories).toBeDefined();
    act(() => api.resetAll());
    expect(api.skillsOverride.categories).toBeUndefined();
    expect(api.hasEdits).toBe(false);
  });

  it("round-trips the snapshot through snapshot → replay", () => {
    act(() => api.renameSkillCategory(cats, 0, "UI"));
    // Second op composes on the flushed snapshot (mirrors the component reading
    // the applied `parsed.skillCategories` between edits).
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 1));
    const saved = api.snapshot;
    act(() => api.resetAll());
    expect(api.skillsOverride.categories).toBeUndefined();
    act(() => api.replay(saved));
    expect(api.skillsOverride.categories?.map((c) => c.label)).toEqual(["UI"]);
  });

  it("delete-all-categories then flat addSkill does NOT resurrect deleted skills (#415)", () => {
    // The pristine parse `applyOverrides` always re-folds against.
    const parsed = { skills: cats.flatMap((c) => c.skills), skillCategories: cats };

    // Delete every category. Each op composes on the current applied snapshot,
    // mirroring the component reading `parsed.skillCategories` between edits.
    act(() => api.deleteSkillCategory(cats, 0));
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    // Degraded: an empty-but-present snapshot (`[]`), NOT absent — this is what
    // keeps computeEditedSkills out of the pristine flat branch.
    expect(api.skillsOverride.categories).toEqual([]);
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([]);

    // The flat AddSkillInput is now live; the user adds one skill.
    act(() => api.addSkill("Rust"));
    // addSkill must PRESERVE the `[]` snapshot (align with removeSkill), else the
    // override falls back to the pristine flat branch and every deleted skill
    // reappears — the #415 bug.
    expect(api.skillsOverride.categories).toEqual([]);
    expect(api.skillsOverride.added).toEqual(["Rust"]);
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([
      "Rust",
    ]);

    // …then removes it → back to empty (not resurrected).
    act(() => api.removeSkill("Rust"));
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([]);
  });

  it("delete-all then add twice keeps both adds, no pristine skills (#415)", () => {
    const parsed = { skills: cats.flatMap((c) => c.skills), skillCategories: cats };
    act(() => api.deleteSkillCategory(cats, 0));
    act(() => api.deleteSkillCategory(api.skillsOverride.categories!, 0));
    act(() => api.addSkill("Rust"));
    act(() => api.addSkill("Go"));
    expect(api.skillsOverride.categories).toEqual([]);
    expect(computeEditedSkills(parsed, api.skillsOverride).skills).toEqual([
      "Rust",
      "Go",
    ]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Exhaustive per-operation tests for the #476 Skills-category mutation path.
 * Every op asserts the #473 invariant — flat `skills` deep-equals
 * `skillCategories.flatMap((c) => c.skills)` — holds AFTER it, plus its own
 * op-specific contract (rename byte-identity, move set-equality, empty-but-
 * present agreement, uncategorised unchanged).
 */

import { describe, it, expect } from "vitest";
import {
  addCategory,
  addSkillToCategory,
  computeEditedSkills,
  deleteCategory,
  isEmptySkillsOverride,
  moveSkillBetweenCategories,
  removeSkillFromCategories,
  renameCategory,
} from "./skills-categories.ts";
import type { SkillCategory } from "../heuristics/types.ts";
import type { SkillsOverride } from "../../hooks/useEditableParse.ts";

const cats = (): SkillCategory[] => [
  { label: "Databases & Caching", skills: ["PostgreSQL", "MySQL", "Redis"] },
  { label: "Backend", skills: ["Java", "Python"] },
];

const EMPTY: SkillsOverride = { removed: [], added: [] };

/** The invariant every op must preserve. */
function invariantHolds(result: {
  skills: string[];
  skillCategories?: SkillCategory[];
}): boolean {
  if (!result.skillCategories) return true; // uncategorised — invariant N/A.
  const flat = result.skillCategories.flatMap((c) => c.skills);
  return JSON.stringify(flat) === JSON.stringify(result.skills);
}

/** Reduce a parsed categorised résumé through a category snapshot. */
function reduce(snapshot: SkillCategory[]) {
  const parsed = { skills: cats().flatMap((c) => c.skills), skillCategories: cats() };
  return computeEditedSkills(parsed, { ...EMPTY, categories: snapshot });
}

describe("isEmptySkillsOverride", () => {
  it("is empty only with no flat edits and no category snapshot", () => {
    expect(isEmptySkillsOverride(EMPTY)).toBe(true);
    expect(isEmptySkillsOverride({ ...EMPTY, added: ["Rust"] })).toBe(false);
    expect(isEmptySkillsOverride({ ...EMPTY, categories: [] })).toBe(false);
  });
});

describe("rename a category", () => {
  it("changes the label only — flat list byte-identical, members untouched", () => {
    const before = reduce(cats());
    const renamed = renameCategory(cats(), 0, "Data Stores");
    const after = reduce(renamed);
    expect(after.skillCategories![0].label).toBe("Data Stores");
    expect(after.skillCategories![0].skills).toEqual([
      "PostgreSQL",
      "MySQL",
      "Redis",
    ]);
    // Byte-identical flat list (the cheap catch for a rename that rebuilds members).
    expect(after.skills).toEqual(before.skills);
    expect(invariantHolds(after)).toBe(true);
  });

  it("ignores a blank label (never a bare ':')", () => {
    const renamed = renameCategory(cats(), 0, "   ");
    expect(renamed[0].label).toBe("Databases & Caching");
  });
});

describe("delete an entire category", () => {
  it("removes the label AND its members in one op", () => {
    const after = reduce(deleteCategory(cats(), 0));
    expect(after.skillCategories!.map((c) => c.label)).toEqual(["Backend"]);
    expect(after.skills).toEqual(["Java", "Python"]);
    expect(invariantHolds(after)).toBe(true);
  });

  it("degrades to uncategorised when the last category is deleted", () => {
    let snap = deleteCategory(cats(), 0);
    snap = deleteCategory(snap, 0);
    const after = reduce(snap);
    expect(after.skillCategories).toBeUndefined();
    expect(after.skills).toEqual([]);
  });
});

describe("add a new category", () => {
  it("appears empty, then populates; shows in the flat list once populated", () => {
    let snap = addCategory(cats(), "Machine Learning");
    const emptyAdd = reduce(snap);
    expect(emptyAdd.skillCategories!.at(-1)).toEqual({
      label: "Machine Learning",
      skills: [],
    });
    // Empty category contributes nothing to the flat list (invariant holds).
    expect(emptyAdd.skills).not.toContain("Machine Learning");
    expect(invariantHolds(emptyAdd)).toBe(true);

    snap = addSkillToCategory(snap, 2, "PyTorch");
    const after = reduce(snap);
    expect(after.skillCategories!.at(-1)!.skills).toEqual(["PyTorch"]);
    expect(after.skills).toContain("PyTorch");
    expect(invariantHolds(after)).toBe(true);
  });

  it("does not add a duplicate of an existing skill", () => {
    const snap = addSkillToCategory(cats(), 1, "Redis"); // already in category 0
    expect(snap.flatMap((c) => c.skills).filter((s) => s === "Redis")).toHaveLength(1);
  });
});

describe("move a skill between categories", () => {
  it("is atomic: same SET, invariant holds, only the grouping changes", () => {
    const before = reduce(cats());
    const snap = moveSkillBetweenCategories(cats(), "Redis", 1); // → Backend
    const after = reduce(snap);
    expect(after.skillCategories![0].skills).toEqual(["PostgreSQL", "MySQL"]);
    expect(after.skillCategories![1].skills).toContain("Redis");
    // Flat SET unchanged (order may differ).
    expect(new Set(after.skills)).toEqual(new Set(before.skills));
    expect(invariantHolds(after)).toBe(true);
  });

  it("is a no-op when the skill is already in the destination", () => {
    const snap = moveSkillBetweenCategories(cats(), "Redis", 0);
    expect(snap).toEqual(cats());
  });

  it("moving the last member out empties the source (empty-but-present)", () => {
    let snap = moveSkillBetweenCategories(cats(), "Java", 0);
    snap = moveSkillBetweenCategories(snap, "Python", 0);
    const after = reduce(snap);
    expect(after.skillCategories![1]).toEqual({ label: "Backend", skills: [] });
    expect(invariantHolds(after)).toBe(true);
  });
});

describe("delete a single skill (categorised)", () => {
  it("drops the skill from its category, category stays present", () => {
    const after = reduce(removeSkillFromCategories(cats(), "MySQL"));
    expect(after.skillCategories![0].skills).toEqual(["PostgreSQL", "Redis"]);
    expect(after.skills).not.toContain("MySQL");
    expect(invariantHolds(after)).toBe(true);
  });

  it("delete-last-chip and move-last-member-out agree (both empty-but-present)", () => {
    // Empty "Backend" via chip deletes:
    let byDelete = removeSkillFromCategories(cats(), "Java");
    byDelete = removeSkillFromCategories(byDelete, "Python");
    // Empty "Backend" via moving both members into "Databases & Caching":
    let byMove = moveSkillBetweenCategories(cats(), "Java", 0);
    byMove = moveSkillBetweenCategories(byMove, "Python", 0);
    // Both leave Backend present and empty.
    expect(byDelete[1]).toEqual({ label: "Backend", skills: [] });
    expect(byMove[1]).toEqual({ label: "Backend", skills: [] });
  });
});

describe("all-deleted snapshot composes flat edits on an EMPTY base (#415)", () => {
  // Pristine categorised résumé (the flat list is the flattening of the groups).
  const pristine = {
    skills: cats().flatMap((c) => c.skills), // Postgres, MySQL, Redis, Java, Python
    skillCategories: cats(),
  };
  /** Reduce the pristine parse through a degraded (`[]`) snapshot + flat edits —
   *  exactly what `applyOverrides` runs after the flat AddSkillInput becomes live. */
  const degraded = (over: Partial<SkillsOverride>) =>
    computeEditedSkills(pristine, { ...EMPTY, categories: [], ...over });

  it("delete-all then add: the added skill is the ONLY skill — no resurrection", () => {
    const after = degraded({ added: ["Rust"] });
    expect(after.skills).toEqual(["Rust"]);
    expect(after.skillCategories).toBeUndefined();
  });

  it("delete-all then add then remove: back to empty", () => {
    // removeSkill drops "rust" from `added` and records it in `removed`.
    const after = degraded({ removed: ["rust"], added: [] });
    expect(after.skills).toEqual([]);
    expect(after.skillCategories).toBeUndefined();
  });

  it("delete-all then add twice: both adds present, still no pristine skills", () => {
    const after = degraded({ added: ["Rust", "Go"] });
    expect(after.skills).toEqual(["Rust", "Go"]);
    expect(after.skillCategories).toBeUndefined();
  });

  it("delete-all with no flat edit yet stays empty (regression guard)", () => {
    const after = degraded({});
    expect(after.skills).toEqual([]);
    expect(after.skillCategories).toBeUndefined();
  });

  it("a pristine skill name is never re-derived — even if re-added by name", () => {
    // Re-adding a name that happened to exist in the pristine parse adds ONLY
    // that one, not the rest of the pristine list.
    const after = degraded({ added: ["Redis"] });
    expect(after.skills).toEqual(["Redis"]);
    expect(after.skills).not.toContain("PostgreSQL");
  });
});

describe("uncategorised résumé (unchanged from pre-#476)", () => {
  const flat = { skills: ["React", "Vue", "Svelte"] };

  it("flat remove + add behave exactly as before; no categories introduced", () => {
    const result = computeEditedSkills(flat, {
      removed: ["vue"],
      added: ["Angular"],
    });
    expect(result.skills).toEqual(["React", "Svelte", "Angular"]);
    expect(result.skillCategories).toBeUndefined();
  });

  it("an empty override is a true passthrough", () => {
    const result = computeEditedSkills(flat, EMPTY);
    expect(result.skills).toEqual(["React", "Vue", "Svelte"]);
    expect(result.skillCategories).toBeUndefined();
  });
});

describe("categorised-untouched résumé", () => {
  it("passes the parsed grouping through unchanged with no snapshot", () => {
    const parsed = {
      skills: cats().flatMap((c) => c.skills),
      skillCategories: cats(),
    };
    const result = computeEditedSkills(parsed, EMPTY);
    expect(result.skillCategories).toEqual(cats());
    expect(invariantHolds(result)).toBe(true);
  });
});

describe("non-empty snapshot + flat edits (unreachable-by-design guard)", () => {
  // The editor never emits `removed`/`added` while a category survives (every
  // categorised edit is snapshotted). Honouring them here would derive a flat
  // list that no longer equals flatMap(categories); the dev guard makes that
  // structurally-impossible state loud instead of silently dropping the edit.
  const parsed = { skills: cats().flatMap((c) => c.skills) };

  it("throws in dev when a non-empty snapshot carries a flat `added`", () => {
    expect(() =>
      computeEditedSkills(parsed, { removed: [], added: ["Rust"], categories: cats() }),
    ).toThrow(/unreachable by design/);
  });

  it("throws in dev when a non-empty snapshot carries a flat `removed`", () => {
    expect(() =>
      computeEditedSkills(parsed, { removed: ["react"], added: [], categories: cats() }),
    ).toThrow(/unreachable by design/);
  });

  it("does NOT throw when the snapshot is empty (degraded-to-flat path)", () => {
    const result = computeEditedSkills(parsed, {
      removed: [],
      added: ["Rust"],
      categories: [],
    });
    expect(result.skills).toEqual(["Rust"]);
    expect(result.skillCategories).toBeUndefined();
  });
});

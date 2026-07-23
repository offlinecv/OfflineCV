// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * skills-categories — the SINGLE mutation path for editing a categorised Skills
 * section (#476).
 *
 * #473 rendered the parser's `skillCategories` grouping read-only; #476 makes it
 * editable (rename a category, delete a category with its members, add a new
 * category, move a skill between categories, delete a single skill). Rather than
 * key each edit against the frozen parse (which forces the editor to translate
 * between the parsed grouping and the edited one), the edited grouping is carried
 * whole as {@link SkillsOverride.categories} — a SNAPSHOT that is exactly what the
 * editor renders. Each edit is a pure array→array transform below
 * (`renameCategory`, `deleteCategory`, `addCategory`, `addSkillToCategory`,
 * `moveSkillBetweenCategories`, `removeSkillFromCategories`); the drag-and-drop
 * drop and the keyboard "Move to" control BOTH call
 * {@link moveSkillBetweenCategories} on the current snapshot, so there is one
 * mutation code path with two ways to invoke it.
 *
 * The load-bearing invariant (from #473, and the whole point of doing this in one
 * place): the flat `skills` array ALWAYS deep-equals
 * `skillCategories.flatMap((c) => c.skills)` — because {@link computeEditedSkills}
 * DERIVES the flat list from the snapshot by flattening, never maintaining the two
 * independently.
 *
 * Empty-category policy (the #476 stated decision): emptying a category (deleting
 * its last chip, or moving its last member out) leaves an EMPTY-BUT-PRESENT
 * category — it survives in the snapshot so the editor can still rename it,
 * re-populate it, or explicitly delete it. It is never silently auto-deleted. Both
 * the delete-last-chip path ({@link removeSkillFromCategories}) and the
 * move-last-member-out path ({@link moveSkillBetweenCategories}) leave the source
 * category present with an empty member list, so the two agree by construction.
 * The exporter (`ats-resume-model.ts`) drops empty categories so the Download PDF
 * / JSON Resume never render a dangling `Label:` with nothing after it.
 *
 * Uncategorised résumés (`skillCategories` absent, and no snapshot taken) keep the
 * flat `removed` / `added` path unchanged — byte-identical to before #476.
 *
 * Pure and dependency-free (aside from `canonicalizeSkill`): unit-tested directly.
 */

import type { SkillCategory } from "../heuristics/types.ts";
import type { SkillsOverride } from "../../hooks/useEditableParse.ts";
import { canonicalizeSkill } from "./skill-canonical.ts";

/** True when no field of the override carries an edit — lets the caller keep the
 *  pristine parse (and its category identity) as a true no-op. */
export function isEmptySkillsOverride(o: SkillsOverride): boolean {
  return (
    o.removed.length === 0 && o.added.length === 0 && o.categories === undefined
  );
}

/** True when any category in `cats` already holds `skill` (case-insensitive). */
function presentAnywhere(cats: readonly SkillCategory[], skill: string): boolean {
  const lc = skill.toLowerCase();
  return cats.some((c) => c.skills.some((s) => s.toLowerCase() === lc));
}

// ── Pure snapshot transforms (each returns a NEW array) ───────────────────────

/** Rename the category at `index` — label-only, members untouched (so the flat
 *  list is byte-identical after a rename). A blank label is ignored (a category
 *  must not render as a bare `:`). */
export function renameCategory(
  cats: readonly SkillCategory[],
  index: number,
  label: string,
): SkillCategory[] {
  const trimmed = label.trim();
  if (!trimmed) return cats.map((c) => ({ ...c, skills: [...c.skills] }));
  return cats.map((c, i) =>
    i === index ? { label: trimmed, skills: [...c.skills] } : { ...c, skills: [...c.skills] },
  );
}

/** Delete the whole category at `index` (label AND its members), atomically. */
export function deleteCategory(
  cats: readonly SkillCategory[],
  index: number,
): SkillCategory[] {
  return cats
    .filter((_, i) => i !== index)
    .map((c) => ({ ...c, skills: [...c.skills] }));
}

/** Append a new, empty category with `label` (populate it via
 *  {@link addSkillToCategory}). A blank label falls back to "New category". */
export function addCategory(
  cats: readonly SkillCategory[],
  label: string,
): SkillCategory[] {
  return [
    ...cats.map((c) => ({ ...c, skills: [...c.skills] })),
    { label: label.trim() || "New category", skills: [] },
  ];
}

/** Add a (canonicalized) skill into the category at `index`. No-op for blank
 *  input or a duplicate of any already-present skill (the set stays unique). */
export function addSkillToCategory(
  cats: readonly SkillCategory[],
  index: number,
  skill: string,
): SkillCategory[] {
  const canonical = canonicalizeSkill(skill);
  const next = cats.map((c) => ({ ...c, skills: [...c.skills] }));
  if (!canonical || presentAnywhere(next, canonical)) return next;
  if (index < 0 || index >= next.length) return next;
  next[index].skills.push(canonical);
  return next;
}

/**
 * Move `skill` (matched case-insensitively) into the category at `destIndex` —
 * one atomic op. It leaves whatever category currently holds it (which may empty
 * that category — empty-but-present) and joins the destination; a no-op when it
 * is already in the destination or when either endpoint can't be resolved. The
 * flat SET is unchanged; only the grouping (and possibly the flat order) moves.
 */
export function moveSkillBetweenCategories(
  cats: readonly SkillCategory[],
  skill: string,
  destIndex: number,
): SkillCategory[] {
  const lc = skill.toLowerCase();
  const next = cats.map((c) => ({ ...c, skills: [...c.skills] }));
  if (destIndex < 0 || destIndex >= next.length) return next;
  let display: string | undefined;
  for (let i = 0; i < next.length; i++) {
    const at = next[i].skills.findIndex((s) => s.toLowerCase() === lc);
    if (at < 0) continue;
    if (i === destIndex) return next; // already in the destination → no reorder.
    display = next[i].skills[at];
    next[i].skills.splice(at, 1);
    break;
  }
  if (display === undefined) return next;
  const dest = next[destIndex];
  if (!dest.skills.some((s) => s.toLowerCase() === lc)) dest.skills.push(display);
  return next;
}

/** Remove `skill` (case-insensitive) from whichever category holds it — the
 *  categorised delete-single-skill path. The category stays present even if it is
 *  now empty (empty-but-present), matching the move-last-member-out result. */
export function removeSkillFromCategories(
  cats: readonly SkillCategory[],
  skill: string,
): SkillCategory[] {
  const lc = skill.toLowerCase();
  return cats.map((c) => ({
    ...c,
    skills: c.skills.filter((s) => s.toLowerCase() !== lc),
  }));
}

// ── Reducer (override → edited skills) ────────────────────────────────────────

/** The two flat fields of the parsed résumé this reducer reads. */
export interface SkillsInput {
  skills: string[];
  skillCategories?: SkillCategory[];
}

/** The reduced result: the flat list, plus the structured view when the résumé
 *  is (still) categorised. `skillCategories` is ABSENT — never `[]` — when every
 *  category was deleted, degrading the résumé to uncategorised (#473 convention:
 *  absent means "no categories", not "an empty set of categories"). */
export interface SkillsResult {
  skills: string[];
  skillCategories?: SkillCategory[];
}

/** Apply the flat `removed` / `added` edits to `base`: drop every `removed` key
 *  (case-insensitive), then append each `added` skill that isn't already present
 *  (case-insensitive). Shared by the uncategorised path (base = the pristine
 *  parsed skills) AND the all-deleted degraded snapshot (base = the emptied
 *  grouping's flattening — NEVER the pristine list, so deleted skills stay gone).
 *  Returns a fresh array; `base` is not mutated. */
function applyFlatEdits(
  base: readonly string[],
  override: SkillsOverride,
): string[] {
  const removedSet = new Set(override.removed.map((s) => s.toLowerCase()));
  const kept = base.filter((s) => !removedSet.has(s.toLowerCase()));
  const present = new Set(kept.map((s) => s.toLowerCase()));
  for (const add of override.added) {
    const key = add.toLowerCase();
    if (present.has(key)) continue;
    present.add(key);
    kept.push(add);
  }
  return kept;
}

/**
 * Apply a {@link SkillsOverride} to a parsed résumé's skills.
 *
 * When a category SNAPSHOT is present, it IS the edited grouping: the flat list
 * is its flattening, so the #473 invariant holds by construction.
 *
 * An all-deleted snapshot (`categories: []`) degrades the section to
 * uncategorised — `SkillsSection` then renders the flat `AddSkillInput` wired to
 * the flat `addSkill`/`removeSkill` setters. Those flat edits are composed ON TOP
 * of the emptied snapshot (an EMPTY base), NOT re-derived from the pristine parse:
 * re-deriving from `parsed.skills` would resurrect every skill the user just
 * deleted (#415). `categories: []` (present, empty — distinct from absent) is what
 * keeps this branch selected over the pristine flat branch below; the flat setters
 * therefore MUST preserve the `[]` snapshot through subsequent adds/removes so the
 * override never falls back into the pristine branch.
 *
 * With no snapshot (`categories` ABSENT), the résumé is either uncategorised or
 * categorised-untouched: apply the flat `removed` / `added` to the pristine parse
 * (the pre-#476 behaviour), and pass a categorised-untouched résumé's
 * `skillCategories` through unchanged (its flat edits are empty by construction —
 * the editor takes a snapshot for any category résumé's skill edit). A non-empty
 * flat edit on a categorised résumé (which the editor never produces — the flat
 * input is unreachable while any category survives) drops the grouping rather than
 * let it drift.
 */
export function computeEditedSkills(
  parsed: SkillsInput,
  override: SkillsOverride,
): SkillsResult {
  if (override.categories) {
    const cats = override.categories;
    // Degraded-to-uncategorised: flat edits accumulate on the emptied snapshot.
    if (cats.length === 0) return { skills: applyFlatEdits([], override) };
    // A non-empty snapshot is authoritative: the flat list is DERIVED from it, so
    // honouring `removed`/`added` here would break the load-bearing invariant
    // `skills === flatMap(categories)`. The editor never emits flat edits while a
    // category survives (every categorised edit is snapshotted; the flat
    // AddSkillInput renders only once the section has degraded to uncategorised),
    // so those fields are structurally empty on this branch. Assert it in dev
    // rather than silently drop a flat edit a future caller might wrongly attach.
    if (
      import.meta.env?.DEV &&
      (override.removed.length > 0 || override.added.length > 0)
    ) {
      throw new Error(
        "computeEditedSkills: flat removed/added with a non-empty category " +
          "snapshot — unreachable by design (would violate skills === flatMap(categories))",
      );
    }
    return { skills: cats.flatMap((c) => c.skills), skillCategories: cats };
  }

  const kept = applyFlatEdits(parsed.skills, override);
  const untouched = override.removed.length === 0 && override.added.length === 0;
  if (parsed.skillCategories && untouched) {
    return { skills: kept, skillCategories: parsed.skillCategories };
  }
  return { skills: kept };
}

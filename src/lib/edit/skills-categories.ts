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
 * The load-bearing invariant through #790 was that the flat `skills` array
 * ALWAYS deep-equals `skillCategories.flatMap((c) => c.skills)`. #791 breaks
 * that on purpose: creating the FIRST category on an uncategorised résumé must
 * not sweep the existing skills into it or invent a synthetic bucket for them
 * (the #791 stated decision), so the grouping can legitimately cover only a
 * SUBSET of the flat list. The invariant becomes `skills ⊇ flatMap(categories)`;
 * {@link SkillsOverride.ungrouped} carries the remainder — whatever `categories`
 * doesn't (yet) claim — as its own tracked set, seeded once (by the caller, when
 * the first category is created) and updated in lockstep by every op that moves
 * a skill in or out of the grouping — including the FLAT add/remove setters,
 * which route through `addUngroupedSkill`/`removeUngroupedSkill` rather than
 * emit `removed`/`added` while a category exists. It can't be re-derived by diffing the
 * pristine parse against the current `categories` on every call: that can't tell
 * "never grouped" (stays ungrouped) apart from "grouped, then its category was
 * deleted" (gone for good) — see {@link computeEditedSkills}.
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

/** True when any category in `cats` already holds `skill` (case-insensitive).
 *  Exported for {@link useEditableParse}'s one-time ungrouped seed (#791). */
export function presentAnywhere(
  cats: readonly SkillCategory[],
  skill: string,
): boolean {
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
 * is already in the destination or when the destination can't be resolved. The
 * flat SET is unchanged; only the grouping (and possibly the flat order) moves.
 *
 * `skill` not being found in ANY category is not an error (#791): it means the
 * skill is currently in the UNGROUPED remainder rather than another category —
 * the trailing chip row's "Move to" also calls this. There is nowhere to splice
 * it out of, so it's simply added at the destination; the caller (`useEditableParse`)
 * is responsible for dropping it from {@link SkillsOverride.ungrouped} so it isn't
 * carried in both places.
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
  display ??= skill; // not in any category — an ungrouped skill moving in.
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

// ── Ungrouped-remainder transforms (#791) ─────────────────────────────────────
//
// The remainder is the OTHER half of the grouping, so it gets the same treatment
// as `categories`: pure array→array transforms here, not set logic inlined in the
// hook. These two are what make the FLAT setters (`addSkill`/`removeSkill`)
// categorisation-aware — with a non-empty snapshot the flat `removed`/`added`
// are unusable (`computeEditedSkills` rejects them), so a flat write has to land
// in the grouping instead.

/** Add a (canonicalized) skill to the ungrouped remainder — the flat "add skill"
 *  path on a résumé that already has a category. No-op for blank input, for a
 *  dupe of an already-ungrouped skill, or for one a category already holds, all
 *  case-insensitively: the same uniqueness {@link addSkillToCategory} enforces,
 *  so the two entry points can't produce a doubled chip between them. */
export function addUngroupedSkill(
  cats: readonly SkillCategory[],
  ungrouped: readonly string[],
  skill: string,
): string[] {
  const next = [...ungrouped];
  const canonical = canonicalizeSkill(skill);
  if (!canonical || presentAnywhere(cats, canonical)) return next;
  const lc = canonical.toLowerCase();
  if (next.some((s) => s.toLowerCase() === lc)) return next;
  next.push(canonical);
  return next;
}

/** Drop `skill` (case-insensitive) from the ungrouped remainder — the sibling of
 *  {@link removeSkillFromCategories}. A delete runs BOTH: a skill is in
 *  `categories` XOR `ungrouped`, and no caller knows which without looking. */
export function removeUngroupedSkill(
  ungrouped: readonly string[] | undefined,
  skill: string,
): string[] {
  const lc = skill.trim().toLowerCase();
  return (ungrouped ?? []).filter((s) => s.toLowerCase() !== lc);
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
 * is `categories` flattened, UNION {@link SkillsOverride.ungrouped} — the skills
 * that exist but aren't (yet) claimed by any category (#791). `ungrouped` is
 * trusted as given rather than re-derived from the pristine parse on every call:
 * `parsed.skills` minus `flatMap(categories)` is AMBIGUOUS on its own — it can't
 * tell a skill that was never grouped (must stay visible) apart from one whose
 * category was just deleted (must stay gone, per the delete confirmation's own
 * promise). Only the caller (`useEditableParse`), which sees each op as it
 * happens, can keep that distinction; this function just trusts the set it's
 * handed.
 *
 * An all-deleted snapshot (`categories: []`) degrades the section to
 * uncategorised — `SkillsSection` then renders the flat `AddSkillInput`, and the
 * flat `addSkill`/`removeSkill` setters emit `added`/`removed` again (they route
 * into the grouping only while a NON-EMPTY snapshot exists, and `[]` is empty by
 * definition — the distinction is load-bearing). Those flat edits are composed ON TOP
 * of `ungrouped` (whatever survived the degrade), NOT re-derived from the
 * pristine parse: re-deriving from `parsed.skills` would resurrect every skill a
 * deleted category took with it (#415/#791). `categories: []` (present, empty —
 * distinct from absent) is what keeps this branch selected over the pristine flat
 * branch below; the flat setters therefore MUST preserve the `[]` snapshot (and
 * `ungrouped`) through subsequent adds/removes so the override never falls back
 * into the pristine branch.
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
    const ungrouped = override.ungrouped ?? [];
    // Degraded-to-uncategorised: flat edits accumulate on the ungrouped
    // remainder, never the pristine parse (#415/#791).
    if (cats.length === 0) return { skills: applyFlatEdits(ungrouped, override) };
    // A non-empty snapshot's grouped members plus the tracked ungrouped
    // remainder are authoritative. Honouring `removed`/`added` here too would
    // let a flat edit drift the flat list out from under BOTH of those, so they
    // stay structurally empty on this branch: every categorised edit (including
    // one on an ungrouped skill) instead goes through `categories`/`ungrouped`.
    // That is enforced in the SETTERS — `useEditableParse`'s flat
    // `addSkill`/`removeSkill` route into `ungrouped`/`categories` whenever a
    // non-empty snapshot exists — not by the flat AddSkillInput being unrendered,
    // which never covered non-UI writers (`SkillTermGuidance` writes through the
    // flat `addSkill`). Assert it in dev rather than silently drop a flat edit a
    // future caller might wrongly attach.
    if (
      import.meta.env?.DEV &&
      (override.removed.length > 0 || override.added.length > 0)
    ) {
      throw new Error(
        "computeEditedSkills: flat removed/added with a non-empty category " +
          "snapshot — unreachable by design (would violate skills ⊇ flatMap(categories))",
      );
    }
    // Reuse applyFlatEdits as a dedup'ing union: `ungrouped` never overlaps a
    // grouped member by construction (every op that grants one to a category
    // also drops it from `ungrouped`), so this is a plain concat in practice.
    return {
      skills: applyFlatEdits(cats.flatMap((c) => c.skills), {
        removed: [],
        added: ungrouped,
      }),
      skillCategories: cats,
    };
  }

  const kept = applyFlatEdits(parsed.skills, override);
  const untouched = override.removed.length === 0 && override.added.length === 0;
  if (parsed.skillCategories && untouched) {
    return { skills: kept, skillCategories: parsed.skillCategories };
  }
  return { skills: kept };
}

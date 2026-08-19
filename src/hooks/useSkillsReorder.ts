// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useSkillsReorder — the confirm/undo controller for the skills-ordering
 * coaching finding (#544).
 *
 * Wraps the pure heuristic (`computeSkillsOrderFinding`,
 * `lib/heuristics/skills-order.ts`) with the SAME apply/undo shape the
 * whole-résumé and per-role rewrite controllers already use
 * (`useResumeRewrite`'s `confirmApplied`/`undoApplied`/`dismiss`, mirrored
 * here as `apply`/`undo`/`dismiss`), so its row renders through the existing
 * `ApplyConfirmation`/`UndoBatchButton` components rather than a new
 * confirm/undo mechanism (the Reuse Gate).
 *
 * One instance per résumé, owned by `ResultDetail` and passed down to the
 * single surface that renders it (`SkillTermGuidance`, via
 * `ReconstructedResume` → `TargetingSection`). The apply/undo state below is
 * this hook's own `useState`, so a second call site would be a second,
 * independent lifecycle over the same list.
 *
 * `apply()` is a no-op while `canApply` is false — a Skills section grouped
 * into categories renders from the GROUPING, not the flat list's array order
 * (`SkillsSection` / `ReconstructedSkills.tsx` reads `skillCategories`, not
 * `skills`'s sequence), so writing a new flat order would silently do
 * nothing on screen. The coaching finding still shows for a categorised
 * résumé — only the one-click Apply is withheld; the chip cluster's own
 * drag / "Move to" controls already reorder within and across categories.
 */

import { useCallback, useMemo, useState } from "react";
import {
  computeSkillsOrderFinding,
  type SkillsOrderFinding,
} from "../lib/heuristics/skills-order.ts";
import type { SkillCategory } from "../lib/heuristics/types.ts";

export interface SkillsReorderController {
  /** Undefined when nothing is worth flagging — see the heuristic's docblock. */
  finding: SkillsOrderFinding | undefined;
  /** False while a non-empty category snapshot exists (see module docblock). */
  canApply: boolean;
  /** True from `apply()` until the confirmation strip's own hold elapses
   *  (`dismiss()`) or the user clicks Undo. */
  applied: boolean;
  /** Write `finding.suggestedOrder` via `reorderSkills`. No-op with no
   *  finding or while `canApply` is false. */
  apply: () => void;
  /** Revert to the order captured just before `apply()`. No-op before an apply. */
  undo: () => void;
  /** The confirmation strip's own auto-collapse (`ApplyConfirmation`'s
   *  `onCollapse`) — clears `applied` without reverting the write. */
  dismiss: () => void;
}

export function useSkillsReorder(
  skills: readonly string[],
  skillCategories: readonly SkillCategory[] | undefined,
  titles: readonly string[],
  reorderSkills: (order: readonly string[]) => void,
): SkillsReorderController {
  const [previous, setPrevious] = useState<string[] | null>(null);

  // Memoised on the CONTENT of the two inputs, not their identity: `titles`
  // reaches us from `deriveTitles(...)`, which mints a fresh array on every
  // render of every caller, so an identity dep would never hit and the memo
  // would be pure overhead. The finding is a fresh object each time it runs,
  // and it is a dep of `apply` below — recomputing it per render churned that
  // callback's identity for every consumer.
  //
  // Deps hand-audited (`exhaustive-deps` is NOT enforced — CLAUDE.md):
  // `skills`/`titles` are read inside but deliberately absent from the dep
  // list, because a key change and a content change are the same event, and
  // `computeSkillsOrderFinding` reads nothing else. `\u0000` cannot occur in a
  // skill or a title, so the join is unambiguous.
  const skillsKey = skills.join("\u0000");
  const titlesKey = titles.join("\u0000");
  const finding = useMemo(
    () => computeSkillsOrderFinding(skills, titles),
    [skillsKey, titlesKey],
  );
  const canApply = !skillCategories || skillCategories.length === 0;

  const apply = useCallback(() => {
    if (!finding || !canApply) return;
    setPrevious([...skills]);
    reorderSkills(finding.suggestedOrder);
  }, [finding, canApply, skills, reorderSkills]);

  const undo = useCallback(() => {
    if (previous === null) return;
    reorderSkills(previous);
    setPrevious(null);
  }, [previous, reorderSkills]);

  const dismiss = useCallback(() => setPrevious(null), []);

  return {
    finding,
    canApply,
    applied: previous !== null,
    apply,
    undo,
    dismiss,
  };
}

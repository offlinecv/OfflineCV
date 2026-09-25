// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * move-targets.ts — the "move to role" affordance's destination list (#1007).
 *
 * A bullet in the "Other bullets" group (`groupBulletsByExperience`'s
 * unmatched bucket) never reaches the exported PDF — `buildAtsResumeModel`
 * only walks bullets keyed to a real `experienceIndex`. Rather than exporting
 * the bucket (a round-trip-model change this issue does not make), the fix is
 * to let the user reattach such a bullet to a real Experience / Project /
 * Achievement / Certification entry, through the SAME `addBullet` +
 * `removeBullet` seam every other bullet edit already uses — once moved, it
 * is an ordinary bullet under an ordinary entry and exports like any other.
 *
 * This module is the pure half: resolving each rendered role's `addedBullets`
 * bucket key. `ExperienceSection`/`ProjectsSection`/`AchievementsSection`
 * already do this resolution per-role inline (an `AddedEntry.id` for a
 * user-added role, a `parsedEntryKey` for a survivor — #856's `parsedIndices`
 * translation) to build each row's OWN entry key; this is the same rule,
 * exposed so `ReconstructedResume` can build the flat cross-section list a
 * move menu needs, without duplicating that resolution a second time.
 */

import type { BulletGroup } from "../score/group-bullets.ts";
import { roleLabel } from "../score/group-bullets.ts";
import type { AddableSection, AddedEntry } from "../../hooks/useEditableParse.ts";
import { parsedEntryKey } from "../../hooks/useEditableParse.ts";

/** One reattachment destination: a real, rendered entry a bullet can move to. */
export interface MoveTarget {
  /** The `addedBullets` bucket key — an `AddedEntry.id` or a `parsedEntryKey`.
   *  Passed straight to `addBullet`. */
  key: string;
  /** Which section the entry belongs to, for the menu's grouping headers. */
  section: AddableSection;
  /** "Title — Company" (or the {@link roleLabel} fallback) display label. */
  label: string;
}

/**
 * Every move target in ONE section, in display order. `groups` is that
 * section's own `BulletGroup[]` (from `buildEntryGroups`) — parsed survivors
 * first, then user-added entries appended at `originalCount` and beyond,
 * exactly as `ExperienceSection` et al. already render them.
 */
export function buildSectionMoveTargets(
  section: AddableSection,
  groups: readonly BulletGroup[],
  parsedIndices: readonly number[],
  addedEntries: readonly AddedEntry[],
  originalCount: number,
): MoveTarget[] {
  const targets: MoveTarget[] = [];
  // Keyed on the RENDER position `i`, the way each section's own rows resolve
  // their entry key — never on `experienceIndex`. `buildEntryGroups` hands
  // project / achievement / certification groups a COMBINED index (offset by
  // every earlier section's length), so reading it as section-local named an
  // entry that does not exist, or the wrong one.
  groups.forEach((g, i) => {
    if (g.experienceIndex === null) return; // the "Other" group is never a target
    const key =
      i >= originalCount
        ? (addedEntries[i - originalCount]?.id ?? parsedEntryKey(section, i))
        : parsedEntryKey(section, parsedIndices[i] ?? i);
    targets.push({ key, section, label: roleLabel(g.experience) });
  });
  return targets;
}

/** {@link buildSectionMoveTargets}'s positional arguments for ONE section —
 *  what `ReconstructedResume` has on hand per section it renders. */
export type SectionMoveInput = readonly [
  section: AddableSection,
  groups: readonly BulletGroup[],
  parsedIndices: readonly number[],
  addedEntries: readonly AddedEntry[],
  originalCount: number,
];

/**
 * The flat cross-section list the move menu renders: every section's
 * {@link buildSectionMoveTargets} output, concatenated in the order given —
 * which is the menu's grouping order, so callers pass sections in display
 * order.
 */
export function buildMoveTargets(
  sections: ReadonlyArray<SectionMoveInput>,
): MoveTarget[] {
  return sections.flatMap((s) => buildSectionMoveTargets(...s));
}

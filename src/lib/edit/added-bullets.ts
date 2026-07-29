// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * added-bullets.ts — the inverse of `addBullet` for a USER-ADDED bullet line
 * (#637).
 *
 * Every other bullet removal in the app is recorded as a
 * `BulletObservation.index` in `removedBullets`, and `applyOverrides` resolves
 * that index against `observations` — the FROZEN base-parse bullet pool. A
 * user-added bullet has no observation in that pool (it was minted by
 * `applyAddedEntriesAndBullets` *after* the parse), so its index resolves to
 * nothing and the removal is silently dropped: the bullet stayed on screen, in
 * the score, and in the exported PDF (#637). The only place an added bullet
 * actually lives is its `addedBullets` bucket, so the only removal that can
 * work is a splice out of that bucket — which is what this module does.
 *
 * Matching is by NORMALISED text, via the same {@link normalizeBulletText} the
 * grouping (`groupBulletsByExperience`) and `applyOverrides`' own line-matching
 * helpers use. Position can't be used: the caller holds a `BulletObservation`
 * from the RE-GRADED pool, whose ordering is the section pool's, not the
 * bucket's.
 *
 * The tiebreak is therefore the FIRST normalised match in the bucket, which is
 * not necessarily the row the user clicked. `normalizeBulletText` lowercases and
 * collapses whitespace, so two lines that differ only in case or spacing are one
 * target here; on a PARSED entry — whose bucket sits alongside parsed bullets —
 * an added line normalising equal to an earlier duplicate is the one spliced.
 * The removal is still correct in effect (the surviving text is identical), but
 * the row identity is not preserved.
 *
 * A second, CROSS-ENTRY tiebreak exists upstream and is not this module's to
 * fix: `groupBulletsByExperience`'s `lineToExpIdx` is first-match-wins across
 * entries, so when two entries carry a normalise-equal line, both group under
 * the first. A bullet added to the second entry then renders under the first and
 * arrives here tagged with the FIRST entry's key — so the splice misses. When
 * that key is a parsed entry the caller deliberately falls through to
 * `removedBullets` (see `useEditableParse.removeBullet`), which is the stale-index
 * hazard documented there. Strictly better than before #637 (every added-bullet
 * remove pushed a stray index), but not eliminated.
 *
 * Pure: no React, no mutation of the input. Returns the input map by REFERENCE
 * when nothing matched, so the caller can tell "spliced" from "no such line"
 * without a second lookup — that distinction is what decides whether a removal
 * falls through to the observation-indexed `removedBullets` path.
 */

import { normalizeBulletText } from "../score/group-bullets.ts";
import type { AddedBullets } from "../../hooks/useEditableParse.ts";

/**
 * Drop the first line of `addedBullets[entryKey]` whose normalised text equals
 * `text`, returning the next map. Returns `addedBullets` ITSELF (same
 * reference) when the bucket is absent or carries no matching line.
 *
 * An emptied bucket is DELETED rather than left as `{key: []}` — `hasEdits`
 * keys off `Object.keys(addedBullets).length`, so a stray empty bucket would
 * leave the résumé permanently "dirty", and `isAddedEntryEmpty` reads
 * `(addedBullets[id] ?? []).length` so either shape would prune the same. This
 * mirrors `replaceAddedBullets`' identical rule.
 */
export function removeAddedBulletLine(
  addedBullets: AddedBullets,
  entryKey: string,
  text: string,
): AddedBullets {
  const lines = addedBullets[entryKey];
  if (lines === undefined) return addedBullets;
  const target = normalizeBulletText(text);
  const at = lines.findIndex((line) => normalizeBulletText(line) === target);
  if (at < 0) return addedBullets;
  const next = { ...addedBullets };
  const remaining = [...lines.slice(0, at), ...lines.slice(at + 1)];
  if (remaining.length === 0) delete next[entryKey];
  else next[entryKey] = remaining;
  return next;
}

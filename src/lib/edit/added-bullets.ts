// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * added-bullets.ts — in-place EDIT and REMOVAL of a USER-ADDED bullet line
 * (#637, #657).
 *
 * Every other bullet removal in the app is recorded as a
 * `BulletObservation.id` in `removedBullets`, and `applyOverrides` folds it by
 * dropping the line that id names from rawText, the section pool and the owning
 * entry's description. A user-added bullet is in NONE of those when that pass
 * runs — `applyAddedEntriesAndBullets` mints its line downstream, out of the
 * bucket — so the removal was silently dropped: the bullet stayed on screen, in
 * the score, and in the exported PDF (#637). The only place an added bullet
 * actually lives is its `addedBullets` bucket, so the only removal that can
 * work is a splice out of that bucket — which is what this module does.
 *
 * Matching is by NORMALISED text, via the same {@link normalizeBulletText} the
 * grouping (`groupBulletsByExperience`), `applyOverrides`' own line-matching
 * helpers, and `bulletId` all use. Position can't be used: the caller holds a
 * `BulletObservation` from the RE-GRADED pool, whose ordering is the section
 * pool's, not the bucket's.
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
 * `removedBullets` (see `useEditableParse.removeBullet`), where the id names no
 * line and the write is inert rather than destructive. Strictly better than
 * before #637 — when every added-bullet remove pushed a stray INDEX, which
 * under the old key space could alias onto an unrelated parsed bullet — but not
 * eliminated.
 *
 * {@link replaceAddedBulletLine} (#657) is the same argument for a non-blank
 * EDIT, which was inert for the identical reason: `applyBulletTextOverrides`
 * find-and-replaces the original text in rawText / sections / the entry
 * description, and an added bullet is in none of them at that point — its line
 * is minted downstream by `applyAddedEntriesAndBullets`, straight out of this
 * bucket. So the edit has to land in the bucket, and it lands HERE rather than
 * as a `bulletOverrides` entry: keeping the bucket authoritative is what makes
 * a later REMOVAL of that same row still find its line (#657 AC4). Were the
 * edit held as an override instead, the bucket would still read the pre-edit
 * text while the row (and the removal's `AddedBulletRef.text`) read the edited
 * one, and the splice would miss — trading an inert edit for an inert removal.
 *
 * Pure: no React, no mutation of the input. Both functions return the input map
 * by REFERENCE when nothing matched, so the caller can tell "written" from "no
 * such line" without a second lookup — that distinction is what decides whether
 * a removal falls through to the id-keyed `removedBullets` path, and whether an
 * edit falls through to `bulletOverrides`.
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

/**
 * Rewrite the first line of `addedBullets[entryKey]` whose normalised text
 * equals `text`, to `replacement` VERBATIM, returning the next map. Returns
 * `addedBullets` ITSELF (same reference) when the bucket is absent, carries no
 * matching line, or the replacement is blank / normalises to the line already
 * there (#657).
 *
 * A blank replacement is NOT a removal: `applyBulletTextOverrides` treats an
 * emptied edit as "revert to the parsed text" rather than as a bullet drop, and
 * an added bullet has no parsed text to revert to, so the only non-surprising
 * reading is "no change". Removal has its own control ({@link
 * removeAddedBulletLine}).
 *
 * Same first-normalised-match tiebreak — and the same caveats — as
 * {@link removeAddedBulletLine}.
 */
export function replaceAddedBulletLine(
  addedBullets: AddedBullets,
  entryKey: string,
  text: string,
  replacement: string,
): AddedBullets {
  const lines = addedBullets[entryKey];
  if (lines === undefined) return addedBullets;
  const trimmed = replacement.trim();
  if (trimmed === "") return addedBullets;
  const target = normalizeBulletText(text);
  const at = lines.findIndex((line) => normalizeBulletText(line) === target);
  if (at < 0) return addedBullets;
  if (lines[at] === trimmed) return addedBullets;
  const next = { ...addedBullets };
  next[entryKey] = [...lines.slice(0, at), trimmed, ...lines.slice(at + 1)];
  return next;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * removeEntryWithBullets — the ONE definition of "delete this entry" for the
 * reconstructed résumé (#856).
 *
 * Every section's remove control routes through here rather than calling
 * `removeEntry` directly, because deleting an entry takes TWO writes against the
 * edit model and the second one is not obvious.
 *
 * `removeEntry` drops the entry from the parsed arrays — which takes its
 * `description` with it, and so takes the Download PDF, the JD-coverage pool and
 * the Completeness entry count. What it cannot take is the entry's BULLETS,
 * because the graded bullet pool is `sections`: a parallel line view built from
 * the extracted text, which the entry never owned a reference into. A bullet
 * left there goes on grading Specificity / Structure for an entry that is no
 * longer on screen, and goes on showing in "Raw text & flags". So each rendered
 * row is dropped through the existing `removeBullet`, which already knows how to
 * splice one line out of all three line containers (`removeBulletFromRawText` /
 * `…Sections` / `…Descriptions`) and how to reach a user-ADDED row in its
 * `addedBullets` bucket. `applyRemovedEntries` is deliberately not taught a
 * second kind of text surgery for this: a `•` line the entry does not itself own
 * is not findable from the entry's fields at all, only from the rendered group.
 *
 * ORDER IS FIXED, bullets first. `removeBullet` matches an added row inside the
 * entry's bucket, and `removeEntry` deletes that bucket outright — so reversing
 * the two would leave every added row with nothing to splice. Both orders happen
 * to end correct today (the bucket delete covers those rows on its own), and
 * pinning the order is what keeps it that way if either side changes.
 */

import type { AddedBulletRef } from "../../hooks/useEditableParse.ts";
import type { BulletObservation } from "../score/score.ts";

/** The two edit-model writers an entry deletion needs. Both are already threaded
 *  into every section for their own sake; `onRemoveBullet` is absent only where
 *  a section has no bullets at all (Education). */
export interface EntryRemoveHandlers {
  /** {@link EditableParse.removeEntry} — added id or {@link parsedEntryKey}. */
  onRemoveEntry: (key: string) => void;
  /** {@link EditableParse.removeBullet}. Omitted for a bullet-less section. */
  onRemoveBullet?: (id: string, added?: AddedBulletRef) => boolean;
}

/**
 * Delete the entry keyed `entryKey` along with every bullet rendered under it.
 *
 * `bullets` is the entry's rendered group — the re-graded rows the user can
 * actually see — so `b.text` is each row's CURRENT text, which is what both
 * halves of `removeBullet`'s routing match on.
 */
export function removeEntryWithBullets(
  entryKey: string,
  bullets: readonly BulletObservation[],
  { onRemoveEntry, onRemoveBullet }: EntryRemoveHandlers,
): void {
  for (const bullet of bullets) {
    onRemoveBullet?.(bullet.id, { entryKey, text: bullet.text });
  }
  onRemoveEntry(entryKey);
}

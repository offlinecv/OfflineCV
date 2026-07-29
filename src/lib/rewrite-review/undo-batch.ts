// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * undo-batch.ts — single-level, exact undo for an applied rewrite batch
 * (issue 510).
 *
 * Applying a rewrite proposal is the one bulk mutation in the app with no way
 * back: `ResumeRewriteProposed`'s `onApply` (whole-résumé) and
 * `SectionRewrite`'s `onApply` (per-role) walk every accepted pair and fire
 * `replace` / `remove` / `add` writes across many sections in one pass, then
 * drop the proposal. This module is the inverse.
 *
 * SNAPSHOT, not reverse-diff. The requirement is "restore every field the
 * batch touched to its EXACT pre-apply value", single-level, one-shot — which
 * is exactly what a snapshot gives with no reconstruction step to get wrong. A
 * reverse diff would have to re-derive the prior value of each slot from the
 * write itself, and for two of the three channels it simply cannot:
 *
 *   - `remove` writes into a SET. `removeBullet(id)` on an already-removed
 *     bullet is a no-op, so the inverse of "remove i" is "restore i" only when
 *     i was not already removed. That fact lives in the pre-state, nowhere in
 *     the write.
 *   - `add` APPENDS to a per-entry array and silently drops blank text, so the
 *     number of writes issued is not the number of bullets appended, and
 *     duplicate texts make removal-by-value ambiguous.
 *
 * The snapshot is SCOPED to the slots the batch will touch, not the whole
 * résumé model — capturing three small maps rather than cloning the parse, and
 * leaving every untouched field alone.
 *
 * Because the restore is wholesale over those slots, an undo issued after the
 * user has hand-edited one of the SAME slots also reverts that hand edit. That
 * is the literal reading of "restore to its exact pre-apply value", and the
 * window is bounded — the Undo affordance is only mounted alongside the apply
 * confirmation and is one-shot.
 *
 * Pure: no I/O, no React, no mutation of the inputs. The caller (see
 * `useEditableParse.captureBulletUndo`) binds the live edit state and the
 * setters; the two apply surfaces only ever see the returned thunk.
 */

import type { ResolvedWrite } from "./apply-accepted.ts";

/** The bullet slots one section's batch is about to write. */
export interface BulletUndoTargets {
  /** BulletObservation ids a `replace` will overwrite. */
  replaced: readonly string[];
  /** BulletObservation ids a `remove` will drop. */
  removed: readonly string[];
  /** The added-bullet entry key an `add` appends to, a `remove` splices out of
   *  (#637), or a `replace` rewrites in place (#657). Set iff the batch has at
   *  least one write of any kind. */
  addedEntryKey?: string;
}

/**
 * Which slots `writes` will touch. `entryKey` is the caller's own added-bullet
 * bucket (the role's `AddedEntry.id` or its `parsedEntryKey`); it is recorded
 * for EVERY write kind, because each of the three can land in that bucket rather
 * than in the id-keyed maps when its target is a USER-ADDED bullet: an `add`
 * appends to it (always), a `remove` splices out of it (#637), and a `replace`
 * rewrites a line in place (#657). For the latter two, `restore` / the override
 * snapshot alone cannot undo the write — nothing was written there.
 *
 * Recording the bucket for a remove that turns out to have targeted a PARSED
 * bullet is harmless: the snapshot then holds the bucket's unchanged value and
 * restoring writes it straight back (and an absent bucket snapshots as `[]`,
 * which restores as a delete — a no-op).
 */
export function batchUndoTargets(
  writes: readonly ResolvedWrite[],
  entryKey: string,
): BulletUndoTargets {
  const replaced: string[] = [];
  const removed: string[] = [];
  for (const write of writes) {
    if (write.kind === "replace") replaced.push(write.obsId);
    else if (write.kind === "remove") removed.push(write.obsId);
  }
  return writes.length > 0
    ? { replaced, removed, addedEntryKey: entryKey }
    : { replaced, removed };
}

/** The live edit state the snapshot reads. Structural on purpose — this module
 *  must not import the hook that owns it. */
export interface BulletEditReadModel {
  bulletOverrides: Readonly<Record<string, string>>;
  removedBullets: ReadonlySet<string>;
  addedBullets: Readonly<Record<string, readonly string[]>>;
}

/** Pre-apply state of exactly the targeted slots. */
export interface BulletUndoSnapshot {
  /** `[obsId, prior override]` — `undefined` means "no override", which
   *  restores by DELETING the key, not by writing an empty string. */
  overrides: readonly (readonly [string, string | undefined])[];
  /** Ids the batch will newly remove — i.e. those NOT already removed.
   *  An already-removed id is left out so undo can't un-remove a bullet
   *  the user had dropped before the batch ran. */
  restore: readonly string[];
  /** `[entryKey, prior bullet list]` for the one bucket the batch appends to. */
  added?: readonly [string, readonly string[]];
}

/** Read the pre-apply value of every targeted slot. Call BEFORE the write loop. */
export function captureBulletUndoSnapshot(
  targets: BulletUndoTargets,
  model: BulletEditReadModel,
): BulletUndoSnapshot {
  const overrides = targets.replaced.map(
    (id) => [id, model.bulletOverrides[id]] as const,
  );
  const restore = targets.removed.filter((id) => !model.removedBullets.has(id));
  const key = targets.addedEntryKey;
  return key === undefined
    ? { overrides, restore }
    : { overrides, restore, added: [key, [...(model.addedBullets[key] ?? [])]] };
}

/** The inverse writes. Mirrors `useEditableParse`'s own edit primitives. */
export interface BulletUndoWriter {
  /** `undefined` deletes the override (back to the parsed text). */
  setBulletField: (id: string, value: string | undefined) => void;
  /** Un-remove a bullet the batch dropped. */
  restoreBullet: (id: string) => void;
  /** Replace an entry's added-bullet list wholesale; `[]` clears the bucket. */
  setAddedBullets: (entryKey: string, bullets: readonly string[]) => void;
}

/** Write every captured slot back. Idempotent — replaying it is a no-op, so a
 *  double-invoked handler (React StrictMode) cannot double-revert. */
export function restoreBulletUndoSnapshot(
  snapshot: BulletUndoSnapshot,
  writer: BulletUndoWriter,
): void {
  for (const [id, value] of snapshot.overrides) writer.setBulletField(id, value);
  for (const id of snapshot.restore) writer.restoreBullet(id);
  if (snapshot.added) writer.setAddedBullets(snapshot.added[0], snapshot.added[1]);
}

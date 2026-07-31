// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useOtherBulletsRemove — the "Other bullets" group's remove control: the one
 * bullet removal in the app whose target bucket has to be DISCOVERED rather than
 * named, and therefore the one whose undo snapshot and prune hold cannot be
 * derived from an `entryKey` the caller already holds.
 *
 * Lifted out of `ExperienceSection` (`ReconstructedResume.tsx`) because all four
 * halves of it — resolve, snapshot, write, hold — have to agree about a single
 * value, and that agreement is the whole correctness argument. Keeping them in
 * one module is what makes it auditable in one read.
 *
 * ## Why the strip is section-owned (#626)
 *
 * `groupBulletsByExperience` appends the "Other" group only while it has at least
 * one bullet, so removing its LAST bullet unmounts the `RoleEntry` that triggered
 * the remove — and would take a role-hosted "Removed 1 change · Undo" strip with
 * it. Every parsed role keeps owning its own strip (it survives losing its
 * bullets, via `sliceGroups`' empty-group fallback), so only this one bucket
 * lifts. The section renders the returned {@link BulletRemoveControl.strip}.
 *
 * ## Why the bucket is resolved from the row's TEXT (#660 half 2)
 *
 * The group owns no entry, so it cannot name a bucket the way every other remove
 * path does — it has no `entryKey` for an `AddedBulletRef`. It usually does not
 * need one: `applyAddedEntriesAndBullets` writes each added line into its entry's
 * own description, and `buildEntryGroups` grades experiences, projects and
 * achievements against one combined index space, so an added line matches its
 * entry and never falls through to "Other".
 *
 * Usually, not always — a line whose normalised key is EMPTY is the exception,
 * because that is the one key `groupBulletsByExperience` skips, so no description
 * can claim it. `addBullet` refuses to mint one since #660, but an in-place edit
 * still can (`replaceAddedBulletLine` rejects only a blank replacement), and such
 * a line lands here. Dropping the row's `text` left its Remove inert AND pushed an
 * id of the shape `"<n>|"` into `removedBullets`, which `resolveOverrideOriginal`
 * resolves to nothing — a permanently unresolvable entry that keeps the résumé
 * "dirty" (#660).
 *
 * So resolve the bucket from the text instead. `findAddedBulletEntry` returns
 * undefined for a genuinely-unmatched parsed bullet, which then falls through to
 * the id-keyed path as before.
 *
 * That fall-through is where the resolver's reach ends, and it is not free: a
 * PARSED degenerate line is in no bucket either, so it misses here too and lands
 * on the id-keyed path carrying the same unresolvable `"<n>|"`. Real Word exports
 * produce one — `"• 4."`, or `"•"` + `"4."` merged by the lone-bullet rule (#30) —
 * so the id-keyed path itself has to refuse an id whose text half is empty.
 * `useEditableParse.removeBullet` does, returning false, which is what keeps #660
 * AC 2 unconditional rather than true only for the added half.
 *
 * ## One resolver, because the snapshot and the write must not disagree
 *
 * `useBulletRemoveStatus` snapshots BEFORE it writes, so the bucket is resolved
 * twice per click — once for the snapshot, once for the splice. Before the
 * resolver existed the capture could pass any placeholder, because no bucket was
 * ever spliced on this path; once one is, a capture that names a DIFFERENT bucket
 * arms an Undo over a slot the write never touched. `batchUndoTargets` records
 * the key for every write kind, `captureBulletUndoSnapshot` reads that bucket as
 * `[]` when it does not exist, and `restoreBulletUndoSnapshot` then "restores" it
 * by deleting a key that was never there — a mounted, clickable Undo that reports
 * "Reverted 1 change" and puts nothing back. That is #659's own defect family, so
 * the resolution rule is written once, here, and both call sites go through it.
 *
 * The two calls provably agree. {@link findAddedBulletEntry} is pure, both calls
 * pass the same `text`, and both read the same `addedBullets` — the hook rebuilds
 * its `removeBullet` whenever either of the callbacks below changes, and both
 * change together with the map, so a single click cannot straddle two renders.
 *
 * When nothing resolves, the key handed to `batchUndoTargets` is `undefined`, not
 * a placeholder: no bucket will be written, so none is snapshotted. The removal
 * then lands in `removedBullets`, which the snapshot's `restore` list already
 * covers.
 *
 * ## Why the prune hold lives here (#637 half 2, on this path)
 *
 * Because the removal now splices a real bucket, it can empty a user-ADDED role —
 * and the strip holding that role's Undo is hosted by the SECTION, which
 * `pruneEmptyAddedEntries` never unmounts. `ReconstructedRole`'s own
 * `useHoldWhile` cannot cover it: the holder there is the "Other bullets"
 * `RoleEntry`, whose `entryKey` is `undefined`, so the call is a no-op. Without a
 * hold, `sectionExitBlur` drops the whole role one tick after the next blur while
 * the Undo is still on screen and still offering to restore it — #637's defect a
 * level up, and losing a role rather than a bullet.
 *
 * No `host` element is passed to {@link useHoldWhile}, deliberately. `host`
 * governs only the RELEASE prune (#658), and the subtree that could answer it is
 * the emptied role's, not this section's; an omitted host is documented as
 * "treat every release as still in use", which spares the entry and leaves it to
 * the section-exit pass. That is the conservative half of the choice, and it
 * introduces no new prune trigger on a path #658 never analysed.
 *
 * The held id is STATE, not a ref: the effect that takes the hold has to see it
 * on the render `pending` flips true on, and that render is caused by the same
 * batched update. It costs no extra render — the strip's own `setStatus` already
 * re-renders this section, React batches both, and a repeat of the same key bails
 * out. It is only ever assigned a real added-entry key, never cleared, and that
 * is deliberate on both counts. A later removal that resolves to no bucket leaves
 * the previous key in place: the hold is a lease on `pending`, so a stale key can
 * only ever SPARE an already-empty role for one strip's lifetime, which the next
 * section exit sweeps. And because the id never goes back to `undefined` while
 * the lease is live, {@link useHoldWhile}'s one rough edge — an id dropping to
 * `undefined` mid-hold early-returns without clearing its transition ref, so the
 * stay's end is never reported — stays unreachable from here.
 */

import { useCallback, useState } from "react";
import { useBulletRemoveStatus } from "./BulletRemoveStatus.tsx";
import type { BulletRemoveControl } from "./BulletRemoveStatus.tsx";
import { findAddedBulletEntry } from "../../lib/edit/added-bullets.ts";
import { isAddedEntryKey } from "../../hooks/useEditableParse.ts";
import type {
  AddedBulletRef,
  AddedBullets,
} from "../../hooks/useEditableParse.ts";
import {
  batchUndoTargets,
  type BulletUndoTargets,
} from "../../lib/rewrite-review/undo-batch.ts";
import type { ResolvedWrite } from "../../lib/rewrite-review/apply-accepted.ts";
import { useHoldWhile } from "../../hooks/useAddedEntryPruneHold.ts";
import type { AddedEntryPruneHold } from "../../hooks/useAddedEntryPruneHold.ts";

export function useOtherBulletsRemove({
  addedBullets,
  onRemoveBullet,
  captureBulletUndo,
  pruneHold,
}: {
  /** Every user-added bucket. The "Other" group carries no entry, so the bucket
   *  a degenerate line sits in has to be found by its text (#660). */
  addedBullets: AddedBullets;
  /** Drop a bullet by `BulletObservation.id`, plus the resolved bucket ref.
   *  Returns whether the write landed (#659). */
  onRemoveBullet: (id: string, added?: AddedBulletRef) => boolean;
  /** Snapshot the slots the write will touch, BEFORE it lands (issue 510). */
  captureBulletUndo: (targets: BulletUndoTargets) => () => void;
  /** The section's per-entry stay of execution over `pruneEmptyAddedEntries`. */
  pruneHold: AddedEntryPruneHold;
}): BulletRemoveControl {
  const bucketKey = useCallback(
    (text: string) => findAddedBulletEntry(addedBullets, text),
    [addedBullets],
  );

  const captureUndo = useCallback(
    (writes: readonly ResolvedWrite[], text: string) =>
      captureBulletUndo(batchUndoTargets(writes, bucketKey(text))),
    [captureBulletUndo, bucketKey],
  );

  // The added entry whose bucket the last LANDED removal spliced — the id the
  // hold below is taken over. Set only on a write that reported success, so a
  // no-op removal cannot extend an entry's life (#659) and cannot displace the
  // key belonging to a strip that is still live.
  //
  // Of the three conditions on that write, only `isAddedEntryKey` is load-bearing
  // today, and it is pinned: a PARSED key reaching `heldEntry` would release the
  // added role whose strip is still live, and dropping it turns exactly one case
  // red. The `removed` check is defence in depth — every no-op removal reachable
  // now resolves NO bucket, so `entryKey !== undefined` already covers it, and
  // removing `removed &&` leaves the suite green. Kept because it states the
  // rule the other two only happen to imply.
  const [heldEntry, setHeldEntry] = useState<string | undefined>(undefined);

  const removeBullet = useCallback(
    (id: string, text: string) => {
      const entryKey = bucketKey(text);
      const removed = onRemoveBullet(
        id,
        entryKey === undefined ? undefined : { entryKey, text },
      );
      // Only an ADDED entry is prunable at all, so only its key is worth holding.
      if (removed && entryKey !== undefined && isAddedEntryKey(entryKey)) {
        setHeldEntry(entryKey);
      }
      return removed;
    },
    [onRemoveBullet, bucketKey],
  );

  const control = useBulletRemoveStatus(removeBullet, captureUndo);
  useHoldWhile(pruneHold, heldEntry, control.pending);
  return control;
}

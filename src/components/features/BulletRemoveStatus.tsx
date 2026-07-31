// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useBulletRemoveStatus — the "Removed · Undo" confirmation strip for a
 * single-bullet remove (#626), extracted from `RoleEntry` so the strip can be
 * hosted by a component that OUTLIVES the row — and the group — it was
 * triggered from.
 *
 * Why the state cannot live in `ResumeBulletRow`: removing a bullet drops it
 * from `group.bullets` on the next render, so the row unmounts before any state
 * it held could paint.
 *
 * Why `RoleEntry` is not a safe host either, for one bucket: a PARSED role
 * survives losing its last bullet (`sliceGroups` falls back to an empty group,
 * so the role still renders). The "Other bullets" bucket has no parsed entry to
 * fall back to — `groupBulletsByExperience` appends it only
 * `if (other && other.length > 0)` — so removing its LAST bullet drops the
 * group, unmounts its `RoleEntry`, and would take the strip with it, leaving
 * that remove undoable by nothing. `ExperienceSection` therefore owns that
 * bucket's control and renders `strip` itself, below the group list where the
 * bucket sits (the "Other" group is always appended last, so the strip lands
 * in the same place the bucket's own strip would have).
 *
 * Shape mirrors `useSectionRewrite`: the hook owns the state and returns the
 * JSX it drives for the caller to place.
 */

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { InlineResult } from "@design-system";
import type { ResolvedWrite } from "../../lib/rewrite-review/apply-accepted.ts";
import {
  ApplyConfirmation,
  UndoBatchButton,
  UNDO_HOLD_MS,
} from "./ApplyConfirmation.tsx";

export interface BulletRemoveControl {
  /**
   * Drop one bullet by its `BulletObservation.id` and arm the strip. `text` is
   * the bullet's observation text, which the owner forwards so a USER-ADDED
   * bullet can be located in its `addedBullets` bucket — the id alone cannot
   * reach one (#637, see `added-bullets.ts`). The strip arms only if the write
   * actually landed (#648).
   *
   * Returns whether THIS call changed anything — i.e. whether the strip armed.
   * A boolean rather than a result object because every caller asks the one same
   * question, and the ways a removal can report nothing (an added bullet whose
   * bucket line is already gone; an id already in `removedBullets`; no
   * `onRemoveBullet` wired at all) are indistinguishable to all of them: each
   * means "confirm nothing, arm no undo, hold nothing back". {@link pending}
   * cannot answer this — it is also true while an EARLIER removal's strip is
   * still up, so a caller reading it after a no-op sees a success that belongs
   * to a different write (#659).
   */
  removeBullet: (id: string, text: string) => boolean;
  /** True while a confirmation is showing. Callers use it to suppress an
   *  "empty section" note that would otherwise contradict the strip. */
  pending: boolean;
  /** The confirmation strip — render it somewhere that outlives the removed
   *  row. Null when idle. */
  strip: ReactNode;
}

/**
 * @param onRemoveBullet Drop a bullet by `BulletObservation.id`, plus its
 *   text for the added-bullet path (#637). Absent → `removeBullet` is inert
 *   (the caller renders no remove control either). Returns whether the removal
 *   was RECORDED: this hook used to set `{kind:"removed"}` unconditionally after
 *   calling it, so a write that dropped nothing still confirmed "Removed" — with
 *   an Undo that had nothing to restore, since `captureBulletUndoSnapshot`
 *   filters an already-removed id out of `restore` (#648). The strip now follows
 *   the write (#659) — and so, through {@link BulletRemoveControl.pending}, does
 *   the caller's `useHoldWhile` stay over the section-exit prune, which must not
 *   extend an added entry's life on the strength of a removal that did nothing.
 * @param captureUndo Snapshot the slot the remove will clear, BEFORE the write
 *   (issue 510). Absent → the confirmation renders without an Undo action.
 *
 *   Widened past `SectionRewriteApply["captureUndo"]` by one argument: the row's
 *   `text`. A caller whose bucket has to be RESOLVED from that text rather than
 *   named up front (`useOtherBulletsRemove`, #660 half 2) otherwise has to
 *   re-derive it from the `obsId` by a second, different rule — and if that rule
 *   disagrees with the one the write uses, the snapshot captures a bucket the
 *   write never touches and the Undo restores nothing (#659). Handing the same
 *   `text` to both removes the second rule. Existing single-argument callers stay
 *   assignable.
 */
export function useBulletRemoveStatus(
  onRemoveBullet?: (id: string, text: string) => boolean,
  captureUndo?: (writes: readonly ResolvedWrite[], text: string) => () => void,
): BulletRemoveControl {
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "removed"; undo?: () => void }
    | { kind: "undone" }
  >({ kind: "idle" });

  const removeBullet = useCallback(
    (id: string, text: string): boolean => {
      if (!onRemoveBullet) return false;
      // Snapshot BEFORE the write — once it lands the prior value is gone
      // (issue 510, same rule the rewrite-review Apply follows). For an added
      // bullet the snapshotted slot is the entry's `addedBullets` bucket, which
      // `batchUndoTargets` now records for a `remove` too (#637). `text` goes
      // along so a caller that has to RESOLVE that bucket resolves the same one
      // the write below splices — see the `captureUndo` param docs.
      const undo = captureUndo?.([{ kind: "remove", obsId: id }], text);
      // Nothing was dropped → nothing to confirm, and the snapshot just taken
      // describes a write that never happened. Leave the strip idle rather than
      // arm an Undo over an unchanged slot. Returning early rather than
      // overwriting `status` is load-bearing beyond the copy: a live strip from
      // an EARLIER, real removal keeps its own undo, instead of having it
      // replaced by one snapshotted after that removal already landed — which
      // restores nothing (`captureBulletUndoSnapshot` reads the bucket as it is
      // NOW, and filters an already-removed id out of `restore`) (#659).
      if (!onRemoveBullet(id, text)) return false;
      setStatus({ kind: "removed", undo });
      return true;
    },
    [onRemoveBullet, captureUndo],
  );

  const backToIdle = useCallback(() => setStatus({ kind: "idle" }), []);

  let strip: ReactNode = null;
  if (status.kind === "removed") {
    strip = (
      <InlineResult tone="success">
        <ApplyConfirmation
          verb="Removed"
          count={1}
          sections={[]}
          onCollapse={backToIdle}
          // Only a confirmation that actually hosts an Undo gets the longer
          // hold — mirrors SectionRewrite's own rule.
          holdMs={status.undo ? UNDO_HOLD_MS : undefined}
          action={
            status.undo && (
              <UndoBatchButton
                onUndo={() => {
                  status.undo?.();
                  setStatus({ kind: "undone" });
                }}
              />
            )
          }
        />
      </InlineResult>
    );
  } else if (status.kind === "undone") {
    strip = (
      <InlineResult tone="success">
        <ApplyConfirmation
          verb="Reverted"
          count={1}
          sections={[]}
          onCollapse={backToIdle}
        />
      </InlineResult>
    );
  }

  return { removeBullet, pending: status.kind !== "idle", strip };
}

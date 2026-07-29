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
import type { SectionRewriteApply } from "./SectionRewrite.tsx";
import {
  ApplyConfirmation,
  UndoBatchButton,
  UNDO_HOLD_MS,
} from "./ApplyConfirmation.tsx";

export interface BulletRemoveControl {
  /** Drop one bullet by its `BulletObservation.index` and arm the strip. `text`
   *  is the bullet's observation text, which the owner forwards so a USER-ADDED
   *  bullet can be located in its `addedBullets` bucket — the index alone
   *  cannot reach one (#637, see `added-bullets.ts`). */
  removeBullet: (index: number, text: string) => void;
  /** True while a confirmation is showing. Callers use it to suppress an
   *  "empty section" note that would otherwise contradict the strip. */
  pending: boolean;
  /** The confirmation strip — render it somewhere that outlives the removed
   *  row. Null when idle. */
  strip: ReactNode;
}

/**
 * @param onRemoveBullet Drop a bullet by `BulletObservation.index`, plus its
 *   text for the added-bullet path (#637). Absent → `removeBullet` is inert
 *   (the caller renders no remove control either).
 * @param captureUndo Snapshot the slot the remove will clear, BEFORE the write
 *   (issue 510). Absent → the confirmation renders without an Undo action.
 */
export function useBulletRemoveStatus(
  onRemoveBullet?: (index: number, text: string) => void,
  captureUndo?: SectionRewriteApply["captureUndo"],
): BulletRemoveControl {
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "removed"; undo?: () => void }
    | { kind: "undone" }
  >({ kind: "idle" });

  const removeBullet = useCallback(
    (index: number, text: string) => {
      if (!onRemoveBullet) return;
      // Snapshot BEFORE the write — once it lands the prior value is gone
      // (issue 510, same rule the rewrite-review Apply follows). For an added
      // bullet the snapshotted slot is the entry's `addedBullets` bucket, which
      // `batchUndoTargets` now records for a `remove` too (#637).
      const undo = captureUndo?.([{ kind: "remove", obsIndex: index }]);
      onRemoveBullet(index, text);
      setStatus({ kind: "removed", undo });
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

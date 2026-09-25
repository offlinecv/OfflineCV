// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * OtherBulletMove — the "Other bullets" bucket's export-fidelity affordance
 * (#1007).
 *
 * The bucket renders on screen (`ExperienceSection`'s "Other bullets" group)
 * but `buildAtsResumeModel` (`ats-resume-model.ts`) only walks bullets keyed
 * to a real `experienceIndex`, so anything typed or left here silently never
 * reaches Download PDF. Rather than leave that gap silent, every row in the
 * bucket carries a plain "Not in Download PDF" mark (`OtherBulletTrailing`,
 * mounted per bullet by `RoleEntry`) plus a "Move to…" menu that reattaches
 * the bullet to a real Experience / Project / Achievement / Certification
 * entry — through the SAME `addBullet` + `removeBullet` seam
 * (`useEditableParse`) every other bullet edit already uses. A moved bullet
 * is then an ordinary bullet under an ordinary entry: it re-groups onto that
 * entry's description on the next render and exports like any other.
 *
 * The menu itself is `Popover role="menu"`, the exact shape
 * `AchievementTypePicker` already established (#953) — a labelled trigger, a
 * list of choice buttons, `close` on pick.
 *
 * `useOtherBulletMove` mirrors `useOtherBulletsRemove` one level up: the
 * "Other" group is section-owned because it can vanish entirely when its last
 * bullet goes (`groupBulletsByExperience` appends it only while non-empty), so
 * its move confirmation is a SINGLE section-level control too, not one per
 * row — the same granularity the group's own Remove confirmation already
 * has. A move is modelled as one `captureBulletUndo` batch (an `add` into the
 * target's bucket, paired with a `remove` of the original id) so Undo puts
 * both halves back in one action, reusing `batchUndoTargets` the same way a
 * rewrite-review Apply already combines add+remove writes into one undo.
 */

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Button, InlineResult, Popover, StatusBadge } from "@design-system";
import type {
  AddableSection,
  AddedBulletRef,
} from "../../hooks/useEditableParse.ts";
import type { MoveTarget } from "../../lib/edit/move-targets.ts";
import {
  batchUndoTargets,
  type BulletUndoTargets,
} from "../../lib/rewrite-review/undo-batch.ts";
import { ApplyConfirmation, UndoBatchButton, UNDO_HOLD_MS } from "./ApplyConfirmation.tsx";

const SECTION_MENU_LABEL: Record<AddableSection, string> = {
  experience: "Experience",
  education: "Education",
  projects: "Projects",
  achievements: "Achievements",
  certifications: "Certifications",
};

// ── Move control (section-owned, mirrors useOtherBulletsRemove) ────────────

export interface OtherBulletMoveControl {
  /** Move bullet `id` (observation text `text`) to `target`'s bucket: appends
   *  the text there, then drops the original from "Other". Arms the strip
   *  only when the drop actually landed — a no-op leaves nothing to undo. */
  moveBullet: (id: string, text: string, target: MoveTarget) => void;
  /** The "Moved to …/Undo" confirmation — render where it outlives the row
   *  (section level, same spot `useOtherBulletsRemove`'s strip renders). */
  strip: ReactNode;
}

export function useOtherBulletMove({
  onAddBullet,
  onRemoveBullet,
  captureBulletUndo,
}: {
  onAddBullet: (entryKey: string, text: string) => void;
  onRemoveBullet: (id: string, added?: AddedBulletRef) => boolean;
  captureBulletUndo: (targets: BulletUndoTargets) => () => void;
}): OtherBulletMoveControl {
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "moved"; label: string; undo?: () => void }
    | { kind: "undone" }
  >({ kind: "idle" });

  const moveBullet = useCallback(
    (id: string, text: string, target: MoveTarget) => {
      // Snapshot BEFORE either write lands (issue 510's rule): the batch is
      // one `add` into `target.key`'s bucket plus one `remove` of `id`, which
      // `batchUndoTargets` already models for a mixed add+remove write.
      const undo = captureBulletUndo(
        batchUndoTargets([{ kind: "remove", obsId: id }], target.key),
      );
      onAddBullet(target.key, text);
      const removed = onRemoveBullet(id);
      if (!removed) {
        // The add landed but this bullet was already gone (a stale click on a
        // row mid-remove elsewhere) — leave it duplicated rather than drop
        // the copy just written, and arm no confirmation for a move that did
        // not fully happen. Not reachable from the rendered menu today (a
        // mounted row's own id is always live), kept as a guard rather than
        // an assumption.
        return;
      }
      setStatus({ kind: "moved", label: target.label, undo });
    },
    [onAddBullet, onRemoveBullet, captureBulletUndo],
  );

  const backToIdle = useCallback(() => setStatus({ kind: "idle" }), []);

  let strip: ReactNode = null;
  if (status.kind === "moved") {
    strip = (
      <InlineResult tone="success">
        <ApplyConfirmation
          verb="Moved"
          count={1}
          sections={[status.label]}
          onCollapse={backToIdle}
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

  return { moveBullet, strip };
}

// ── Per-row UI: the hint + the picker ───────────────────────────────────────

/**
 * Mounted per bullet in the "Other bullets" group (`RoleEntry`, as
 * `ResumeBulletRow`'s `trailing`). `StatusBadge tone="neutral"` — this is an
 * ordinary export-scope fact, not a fault: the bullet parsed fine and is
 * fully editable, it just has no role to attach to yet. The menu itself is
 * omitted (not disabled) when there is nowhere to move it — a résumé with no
 * other Experience/Project/Achievement/Certification entry at all.
 *
 * One-way past the Undo hold, except into Experience: only `RoleEntry`'s
 * bullet rows carry the in-place edit + remove seam. `ProjectsSection`,
 * `AchievementsSection` and the certifications list render their bullets as
 * plain `ResumeBulletRow`s, so a bullet moved there keeps its text but loses
 * per-bullet edit and remove once the "Moved · Undo" strip collapses — the
 * only way out is then removing the whole entry. Those sections still
 * export, which is what the move is for, so they stay offered — and the menu
 * says so under them rather than leaving the user to find out.
 */
export function OtherBulletTrailing({
  bulletId,
  bulletText,
  targets,
  onMove,
}: {
  bulletId: string;
  bulletText: string;
  targets: readonly MoveTarget[];
  onMove: (id: string, text: string, target: MoveTarget) => void;
}) {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1.5">
      <StatusBadge tone="neutral">Not in Download PDF</StatusBadge>
      {targets.length > 0 && (
        <Popover
          role="menu"
          label="Move this bullet to an entry"
          panelLabel="Move to"
          // Edit chrome (#913): the trigger never prints, so it rests hidden
          // with the row's other controls. The badge beside it does not — it
          // IS the export-fidelity warning, so it stays visible at rest.
          trigger={{ variant: "ghost", className: "edit-chrome text-2xs" }}
          triggerContent="Move to…"
        >
          {({ close }) => {
            let lastSection: AddableSection | undefined;
            return (
              <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                {targets.map((t) => {
                  const header = t.section !== lastSection;
                  lastSection = t.section;
                  return (
                    <div key={t.key} className="contents">
                      {header && (
                        <div className="mt-1.5 px-2 text-3xs font-semibold uppercase tracking-wider text-content-muted first:mt-0">
                          {SECTION_MENU_LABEL[t.section]}
                        </div>
                      )}
                      <Button
                        role="menuitem"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onMove(bulletId, bulletText, t);
                          close();
                        }}
                        className="justify-start truncate"
                      >
                        {t.label}
                      </Button>
                    </div>
                  );
                })}
                {targets.some((t) => t.section !== "experience") && (
                  <p className="mt-1.5 px-2 text-2xs text-content-muted">
                    Outside Experience, a moved bullet can't be edited on its
                    own once Undo closes.
                  </p>
                )}
              </div>
            );
          }}
        </Popover>
      )}
    </span>
  );
}

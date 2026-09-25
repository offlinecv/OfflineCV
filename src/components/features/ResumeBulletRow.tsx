// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeBulletRow — one graded bullet line in the reconstructed résumé.
 *
 * Carries no in-text annotation (#913). An editable bullet Fix It has a step
 * for shows it through its own `•`, tinted and activatable (`BulletMarker`);
 * the check it failed is named in Fix It's dock, never beside the text, so the
 * row reads the way the exported PDF prints it. A read-only row (project,
 * achievement, certification) is never a Fix It step, so it shows nothing.
 *
 * Split out of `ReconstructedRole.tsx` (#626) rather than grown in place —
 * that file is already past the ~200 LOC guideline and named as known debt in
 * CLAUDE.md.
 *
 * Remove control (#626): the bullet text is editable via the shared
 * `EditableField` primitive, same as before; a per-bullet `RemoveButton` sits
 * alongside it, wired straight to `removeBullet` (already threaded through
 * `useEditableParse` — this is exposure, not new machinery). Its only prior
 * consumer was the WebGPU-gated `SectionRewrite` panel, so hardware without
 * WebGPU had no way to drop a bullet at all.
 *
 * Empty-commit resolution: committing a bullet down to blank text calls
 * `onRemove` instead of writing `""` into the text override. Before this, a
 * cleared bullet rendered as a permanent `"empty bullet"` ghost row — visible
 * in the reconstructed résumé, but ALREADY dropped from the exported PDF by
 * `resolveBullets`'s `.filter(Boolean)` (`ats-resume-model.ts`). Routing the
 * empty commit through the same remove path the button uses keeps the two
 * surfaces in agreement instead of introducing a second "blank but present"
 * concept.
 */

import { useCallback } from "react";
import type { BulletObservation } from "../../lib/score/score.ts";
import { bulletAnchorId } from "../../lib/score/guidance.ts";
import { useFixItTarget } from "../../hooks/useFixItMode.ts";
import { EditableField } from "@design-system";
import { RemoveButton } from "./ReconstructedAdd.tsx";
import { BulletMarker } from "./BulletMarker.tsx";

// ── Bullet row ────────────────────────────────────────────────────────────────

/**
 * One bullet line in the reconstructed resume. The bullet text is editable
 * (#82) via the shared EditableField primitive — committing an edit feeds the
 * authoritative re-grade in App (rawText + description), so the marker's tint
 * re-evaluates live with the Fix It steps it reads.
 */
export function ResumeBulletRow({
  bullet,
  onBulletChange,
  onRemove,
}: {
  /** The graded row as the RE-GRADED pool minted it, so `bullet.text` is
   *  already the post-edit text. There is deliberately no `override` prop to
   *  layer on top: since #648 `assignBulletIds` allocates every live row's id
   *  AROUND the keys `bulletOverrides` already holds, so a live row's id can
   *  never BE such a key and a lookup here would always miss. The old
   *  `override ?? bullet.text` read as the thing that made an edit visible
   *  while being dead code — the re-grade is what makes it visible. */
  bullet: BulletObservation;
  /** Commit an edit on this bullet (keyed by bullet.index in the caller). */
  onBulletChange?: (value: string) => void;
  /** Drop this bullet outright (#626) — keyed by bullet.index in the caller,
   *  which also snapshots the pre-remove state for Undo before calling it.
   *  Absent → no remove control renders and an empty commit falls back to
   *  storing `""` (the pre-#626 behaviour), for any caller that hasn't wired
   *  the remove path. */
  onRemove?: () => void;
}) {
  const editable = onBulletChange !== undefined;
  const displayText = bullet.text;

  const handleCommit = useCallback(
    (v: string) => {
      // Committing down to blank text drops the bullet instead of storing an
      // empty override — see the module docblock. Without this, `resolveBullets`
      // (the export path) silently agrees the bullet is gone while this row
      // keeps rendering the "empty bullet" placeholder forever.
      if (v.trim() === "" && onRemove) {
        onRemove();
        return;
      }
      onBulletChange?.(v);
    },
    [onBulletChange, onRemove],
  );

  const fixIt = useFixItTarget(bulletAnchorId(bullet.id), "inline");

  /*
    Read-only layout: single inline formatting context (a plain block `<li>`,
    NOT a flexbox), so the text wraps as prose.

    Edit layout: the multiline EditableField breaks to a block (full-width
    <div>) so the textarea + action row have room. The row is an `edit-scope`
    (styles/edit-chrome.css): its remove control rests hidden on a fine
    pointer and shows while the row is hovered or holds focus.
  */
  return (
    <li
      id={fixIt.id}
      tabIndex={fixIt.tabIndex}
      className={`edit-scope py-1 text-sm leading-snug text-content-secondary ${fixIt.className}`}
    >
      {editable ? (
        /* Multiline edit mode: block layout, full-width textarea + Save/Cancel,
           the per-bullet remove control trailing on the same row (#626). */
        <div className="flex items-start gap-1.5">
          <BulletMarker bulletId={bullet.id} anchorId={fixIt.id} />
          <div className="min-w-0 flex-1">
            <EditableField
              value={displayText || undefined}
              placeholder="empty bullet"
              emptyAffordance="plain"
              label="Bullet text"
              textSize="sm"
              display="inline"
              multiline
              onCommit={handleCommit}
            />
          </div>
          {/* `RemoveButton` carries the 24×24 minimum target (WCAG 2.2 AA SC
              2.5.8, 24 not 44 — see #581/#591); at 44 a dense per-bullet
              control list would bleed into the next row's target. */}
          {onRemove && <RemoveButton label="Remove bullet" onClick={onRemove} />}
        </div>
      ) : (
        /* Read-only: never a Fix It step, so never flagged (#913). */
        <>
          <span aria-hidden="true" className="mr-1.5 text-content-muted">
            •
          </span>
          {displayText}
        </>
      )}
    </li>
  );
}

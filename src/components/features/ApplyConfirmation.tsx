// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ApplyConfirmation — the in-place "Applied ✓" state shown once a rewrite
 * Apply commits its writes (issue #508). Before this, `onApply` wrote the
 * accepted changes and unconditionally dismissed the whole review panel in
 * the same tick — the only signal anything happened was the panel
 * disappearing. Shared by both apply surfaces so they show identical
 * copy/timing/motion:
 *   - `SectionRewrite.tsx` (per-role review) renders it for its "applied"
 *     status.
 *   - `ResumeRewrite.tsx` renders it for the whole-résumé review's
 *     "applied" status (writes land in the sibling `ResumeRewriteProposed.tsx`).
 *
 * No new toast/snackbar primitive — see CLAUDE.md's reuse rule and #508's
 * Notes on why not. This renders inside the caller's already-mounted
 * `InlineResult`, using `StatusBadge` from the `@design-system` barrel; the
 * word "Applied" always appears in the text, so meaning is never carried by
 * colour alone.
 *
 * Owns its own timing: fades in over ENTER_MS, holds for HOLD_MS, then
 * collapses (grid-rows + opacity) over EXIT_MS and calls `onCollapse` so the
 * caller can drop its status back to idle. Gated on `prefers-reduced-motion`
 * via `motion-reduce:` (the same duration-zeroing idiom the Button primitive
 * uses) — the hold/collapse still happen on schedule, only the animation is
 * skipped.
 *
 * `action` is the slot #510's Undo control mounts in, and `holdMs` is why the
 * strip can outlive its default 3s: an Undo the user cannot reach is not a
 * recovery path, so a confirmation that HOSTS an undo holds for
 * {@link UNDO_HOLD_MS} instead. A confirmation with no `action` still holds for
 * {@link HOLD_MS} — #508's timing is unchanged for the no-undo case.
 *
 * `verb` lets the same strip acknowledge the reverse trip ("Reverted N changes
 * — …") without a second component or a toast primitive.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, StatusBadge } from "@design-system";

// Hold ~3s before collapsing (#508's acceptance criteria). The enter (200ms,
// `duration-200` below) and exit (EXIT_MS, `duration-150` below) both sit
// inside the 150-300ms band, exit shorter than enter — keep those Tailwind
// classes and this constant in sync if either changes.
const HOLD_MS = 3000;
const EXIT_MS = 150;

/** Hold for a confirmation that hosts an Undo (issue 510). Long enough to
 *  read the line, decide, and click — 3s is not. Still bounded, so the strip
 *  never becomes permanent page furniture. */
export const UNDO_HOLD_MS = 12000;

export function ApplyConfirmation({
  count,
  sections,
  onCollapse,
  action,
  holdMs = HOLD_MS,
  verb = "Applied",
}: {
  count: number;
  sections: readonly string[];
  onCollapse: () => void;
  action?: ReactNode;
  /** Milliseconds to hold before collapsing. Defaults to {@link HOLD_MS}. */
  holdMs?: number;
  /** Past-tense verb for the badge and the line. */
  verb?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [collapsing, setCollapsing] = useState(false);

  // A section whose label is blank names nothing, so it must not open the
  // "— …" clause. `roleLabel` never returns "" today, which is exactly why the
  // guard has to key off content rather than length — a caller that grows a
  // blank label would otherwise re-open the dangling-em-dash hole.
  const named = sections.filter((section) => section.trim().length > 0);

  useEffect(() => {
    // Flip to visible on the next frame — otherwise the initial opacity-0
    // paint and this update coalesce into one and the enter never plays.
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const holdTimer = setTimeout(() => setCollapsing(true), holdMs);
    return () => clearTimeout(holdTimer);
  }, [holdMs]);

  useEffect(() => {
    if (!collapsing) return;
    const exitTimer = setTimeout(onCollapse, EXIT_MS);
    return () => clearTimeout(exitTimer);
  }, [collapsing, onCollapse]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`grid transition-[grid-template-rows,opacity] motion-reduce:transition-none motion-reduce:duration-0 ${
        collapsing
          ? "grid-rows-[0fr] opacity-0 duration-150"
          : `grid-rows-[1fr] duration-200 ${visible ? "opacity-100" : "opacity-0"}`
      }`}
    >
      <div className="flex min-h-0 flex-wrap items-center gap-2 overflow-hidden">
        {/* aria-hidden: the badge repeats the verb that already opens the
            line, so a screen reader would announce it twice with no space
            ("AppliedApplied 2 changes"). Meaning is still not carried by
            colour alone — the word itself is in the visible line. */}
        <StatusBadge tone="ok" aria-hidden>
          {verb}
        </StatusBadge>
        <span className="text-[11px] text-content-secondary">
          {verb} {count} change{count === 1 ? "" : "s"}
          {/* No trailing "— " when nothing was named; an empty list left a
              dangling em dash. */}
          {named.length > 0 && ` — ${named.join(", ")}`}
        </span>
        {action}
      </div>
    </div>
  );
}

/**
 * The Undo control both apply surfaces mount in the confirmation's `action`
 * slot (issue 510). One component so the per-role and whole-résumé paths offer
 * the same word, the same affordance, and the same label — an undo the user
 * has to re-learn per surface is not a recovery path.
 */
export function UndoBatchButton({ onUndo }: { onUndo: () => void }) {
  return (
    <Button
      variant="link"
      size="sm"
      onClick={onUndo}
      className="text-[11px] font-medium text-content-secondary"
      aria-label="Undo the changes just applied to the résumé"
    >
      Undo
    </Button>
  );
}

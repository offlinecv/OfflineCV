// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeBulletRow — one graded bullet line in the reconstructed résumé, plus
 * its check-badge glyphs (`BulletFlagLegend` / `BulletFlagsInline`).
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
import type { ReactNode } from "react";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import { EditableField } from "@design-system";
import { RemoveButton } from "./ReconstructedAdd.tsx";

// ── Bullet flags ──────────────────────────────────────────────────────────────

/**
 * Each failed grading rule renders as a compact amber glyph chip inline on the
 * bullet row (was a wide text label per #57–59 — the repeated "no metric" /
 * "weak verb" strings ate horizontal space and forced long bullets to wrap).
 * Glyphs are SVG, not emoji (emoji don't theme and render per-platform). The
 * meaning is never icon-only: each chip carries an `aria-label` + `title`, and
 * `BulletFlagLegend` keys the glyphs at the top of the section.
 */

/** Stroke bar-chart — the missing-metric flag ("quantify this bullet"). */
function MetricIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" x2="20" y1="20" y2="20" />
      <line x1="7" x2="7" y1="20" y2="13" />
      <line x1="12" x2="12" y1="20" y2="9" />
      <line x1="17" x2="17" y1="20" y2="5" />
    </svg>
  );
}

/** Stroke bolt — the weak-opening-verb flag. */
function BoltIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

/**
 * One amber glyph chip. `decorative` mode (used in the legend, where an
 * adjacent text label already names the flag) drops the redundant
 * role/aria-label so screen readers don't announce it twice.
 */
function FlagChip({
  title,
  ariaLabel,
  decorative = false,
  className = "",
  children,
}: {
  title: string;
  ariaLabel: string;
  decorative?: boolean;
  /** Extra layout classes (e.g. inline spacing/alignment at the call site). */
  className?: string;
  children: ReactNode;
}) {
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": ariaLabel, title };
  return (
    <span
      {...a11y}
      className={`inline-flex shrink-0 items-center justify-center rounded px-1 py-0.5 bg-feedback-warning-bg text-feedback-warning-text ${className}`}
    >
      {children}
    </span>
  );
}

/** Short word-count token shown in the length chip (the number is the signal). */
function lengthToken(b: BulletObservation): string {
  return `${b.wordCount}w`;
}

function lengthTitle(b: BulletObservation): string {
  const aim = "aim 8–30 words";
  return b.wordCount < 8
    ? `Too short — ${aim} (${b.wordCount})`
    : `Too long — ${aim} (${b.wordCount})`;
}

/**
 * Glyph key for the bullet flags. Rendered once at the top of the
 * reconstructed-resume section so the inline glyphs stay decodable
 * (`color-not-only` / discoverability).
 */
export function BulletFlagLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-content-tertiary">
      <li className="inline-flex items-center gap-1.5">
        <FlagChip title="No metric" ariaLabel="No metric" decorative>
          <MetricIcon />
        </FlagChip>
        no metric
      </li>
      <li className="inline-flex items-center gap-1.5">
        <FlagChip title="Weak opening verb" ariaLabel="Weak opening verb" decorative>
          <BoltIcon />
        </FlagChip>
        weak verb
      </li>
      <li className="inline-flex items-center gap-1.5">
        <FlagChip
          title="Word count outside 8–30"
          ariaLabel="Word count outside 8–30"
          decorative
        >
          <span className="text-2xs font-medium tabular-nums">#w</span>
        </FlagChip>
        length (8–30 words)
      </li>
    </ul>
  );
}

/**
 * The trailing check badges for one bullet — "no metric" / "weak verb" /
 * length. Shared by both the read-only and editable bullet layouts so the
 * flags never disappear when the reconstructed résumé is editable (the edit
 * branch previously rendered none). Renders nothing for a passing bullet.
 * Inline-level so the chips flow right after the bullet text and wrap with it.
 */
function BulletFlagsInline({ bullet }: { bullet: BulletObservation }) {
  if (!needsAttention(bullet)) return null;
  return (
    <>
      {!bullet.hasMetric && (
        <FlagChip title="No metric" ariaLabel="No metric" className="ml-1 align-middle">
          <MetricIcon />
        </FlagChip>
      )}
      {!bullet.startsWithActionVerb && (
        <FlagChip
          title="Weak opening verb"
          ariaLabel="Weak opening verb"
          className="ml-1 align-middle"
        >
          <BoltIcon />
        </FlagChip>
      )}
      {!bullet.wellFormedLength && (
        <FlagChip
          title={lengthTitle(bullet)}
          ariaLabel={lengthTitle(bullet)}
          className="ml-1 align-middle"
        >
          <span className="text-2xs font-medium tabular-nums">
            {lengthToken(bullet)}
          </span>
        </FlagChip>
      )}
    </>
  );
}

// ── Bullet row ────────────────────────────────────────────────────────────────

/**
 * One bullet line in the reconstructed resume. The bullet text is editable
 * (#82) via the shared EditableField primitive — committing an edit feeds the
 * authoritative re-grade in App (rawText + description), so the inline check
 * badges below re-evaluate live. Flagged bullets show the checks they failed;
 * passing bullets render plain.
 */
export function ResumeBulletRow({
  bullet,
  override,
  onBulletChange,
  onRemove,
}: {
  bullet: BulletObservation;
  /** In-memory override text for this bullet, if any. */
  override?: string;
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
  const displayText = override ?? bullet.text;

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

  /*
    Read-mode layout: single inline formatting context (a plain block `<li>`,
    NOT a flexbox). The bullet text, the check badges, and the rewrite trigger
    are all inline-level, so the badges flow right after the *last word* of the
    text and wrap with it.

    Edit-mode layout: the multiline EditableField breaks to a block (full-width
    <div>) so the textarea + action row have room. The rework pane (if open)
    stacks below the action row as a block child of the `<li>`.
  */
  return (
    <li className="py-1 text-sm leading-snug text-content-secondary">
      {editable ? (
        /* Multiline edit mode: block layout, full-width textarea + Save/Cancel,
           the per-bullet remove control trailing on the same row (#626). */
        <div className="flex items-start gap-1.5">
          <span aria-hidden="true" className="mt-1.5 shrink-0 text-content-muted">
            •
          </span>
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
            {/* Check badges trail the field inline (read mode) so the flags
                stay visible while the résumé is editable. */}
            <BulletFlagsInline bullet={bullet} />
          </div>
          {/* `RemoveButton` carries the 24×24 minimum target (WCAG 2.2 AA SC
              2.5.8, 24 not 44 — see #581/#591); at 44 a dense per-bullet
              control list would bleed into the next row's target. */}
          {onRemove && <RemoveButton label="Remove bullet" onClick={onRemove} />}
        </div>
      ) : (
        /* Read-only: inline flow — bullet text then trailing check badges inline */
        <>
          <span aria-hidden="true" className="mr-1.5 text-content-muted">
            •
          </span>
          {displayText}
          <BulletFlagsInline bullet={bullet} />
        </>
      )}
    </li>
  );
}

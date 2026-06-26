// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * InlineDiff — renders a pre-computed diff as inline redline text.
 *
 * Removed text appears struck through in error red; added text is highlighted
 * in success green; unchanged text is content-secondary. Designed for
 * side-by-side replacement in rewrite panels — one compact block instead of a
 * two-column "Original | Proposed" grid.
 *
 * Props:
 *   `segments`  — output of `computeTextDiff` from `src/lib/diff/text-diff.ts`
 *   `className` — extra classes for the outer block (width, margin, etc.)
 *
 * Rendering notes:
 *   - Outer element is a `<p>` (inline text content, not a structural section).
 *   - `whitespace-pre-wrap` preserves newlines in `• bullet\n• bullet` blocks.
 *   - Segments are keyed by index; text content is never a stable key.
 *   - Semantic tokens only — no raw palette classes or hex values.
 */

import type { DiffSegment } from "../../lib/diff/text-diff.ts";

const SEGMENT_CLASS: Record<DiffSegment["type"], string> = {
  equal: "text-content-secondary",
  removed:
    "bg-feedback-error-bg text-feedback-error-text line-through",
  added:
    "bg-feedback-success-bg text-feedback-success-text font-semibold",
};

interface InlineDiffProps {
  /** Flat segment array from `computeTextDiff`. */
  segments: DiffSegment[];
  /** Extra classes applied to the outer block — width, overflow, etc. */
  className?: string;
}

export function InlineDiff({ segments, className }: InlineDiffProps) {
  const base =
    "whitespace-pre-wrap break-words text-xs leading-snug";
  const cls = className ? `${base} ${className}` : base;
  return (
    <p className={cls}>
      {segments.map((seg, i) => (
        <span key={i} className={SEGMENT_CLASS[seg.type]}>
          {seg.text}
        </span>
      ))}
    </p>
  );
}

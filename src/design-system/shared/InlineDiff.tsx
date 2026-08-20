// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * InlineDiff — renders a pre-computed diff as inline redline text.
 *
 * Removed text appears struck through in error red; added text is highlighted
 * in success green; unchanged text is content-secondary. Designed for
 * side-by-side replacement in rewrite panels — one compact block instead of a
 * two-column "Original | Proposed" grid.
 *
 * Props:
 *   `segments`      — output of `computeTextDiff` from `src/lib/diff/text-diff.ts`
 *   `className`     — extra classes for the outer block (width, margin, etc.)
 *   `noChangeLabel` — caption shown ONLY when the diff has no added/removed
 *                     run, i.e. when the two sides are identical
 *
 * `noChangeLabel` exists because an all-equal diff renders as plain prose that
 * is indistinguishable from any other block of text: the reader cannot tell
 * "these two are the same" from "this is just some text". Whenever a caller
 * produced the two sides by a process that could have changed them and did
 * not, that outcome is information, and the component that owns the redline is
 * the one place that can tell there is nothing to draw. Domain-agnostic on
 * purpose — the caller supplies the sentence (#778's rewrite-rejected notice
 * is the first one), this only decides when it is shown.
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
  /**
   * Caption rendered above the text when the diff contains no `added` or
   * `removed` segment. Omitted → an unchanged diff renders exactly as before.
   */
  noChangeLabel?: React.ReactNode;
}

export function InlineDiff({
  segments,
  className,
  noChangeLabel,
}: InlineDiffProps) {
  const base =
    "whitespace-pre-wrap break-words text-sm leading-snug";
  const cls = className ? `${base} ${className}` : base;
  const unchanged = segments.every((seg) => seg.type === "equal");
  const body = (
    <p className={cls}>
      {segments.map((seg, i) => (
        <span key={i} className={SEGMENT_CLASS[seg.type]}>
          {seg.text}
        </span>
      ))}
    </p>
  );

  if (noChangeLabel === undefined || !unchanged) return body;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs font-medium text-content-tertiary">
        {noChangeLabel}
      </p>
      {body}
    </div>
  );
}

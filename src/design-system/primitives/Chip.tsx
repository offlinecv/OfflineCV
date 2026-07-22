// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { Button } from "./Button.tsx";

export type ChipTone = "neutral" | "success" | "warning";

/** The chip's own remove (×) glyph — kept inline so the primitive stays
 *  self-contained (no feature-layer icon import). Matches the SkillChip X. */
function ChipRemoveIcon() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

interface ChipProps {
  /**
   * Decorative icon (e.g. from `design-system/icons/TrustIcons.tsx`). This
   * slot — not the icon component — owns sizing/alignment: the icon renders
   * at `h-full w-full` inside a fixed `h-3.5 w-3.5` box and is marked
   * `aria-hidden` here, so the chip's accessible name stays its text alone.
   * Callers pass an icon node, never a size.
   */
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: ChipTone;
  /**
   * When set, the chip renders a trailing remove (×) control that calls this
   * on click — the removable-chip variant, so a labelled list (Titles, Skills)
   * reuses the one chip implementation instead of hand-rolling its own. Pass
   * `removeLabel` for the control's accessible name.
   */
  onRemove?: () => void;
  /** Accessible name for the remove control; required when `onRemove` is set. */
  removeLabel?: string;
}

export function Chip({
  icon,
  children,
  tone = "neutral",
  onRemove,
  removeLabel,
}: ChipProps) {
  const toneCls =
    tone === "success"
      ? "bg-feedback-success-bg text-feedback-success-text"
      : tone === "warning"
        ? "bg-feedback-warning-bg text-feedback-warning-text"
        : "bg-surface-subtle text-content-secondary";
  // Tighten the trailing padding when a remove control sits in that slot.
  const padCls = onRemove ? "py-1 pl-2.5 pr-1" : "px-2.5 py-1";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full text-xs ${padCls} ${toneCls}`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 [&>svg]:h-full [&>svg]:w-full"
        >
          {icon}
        </span>
      )}
      {children}
      {onRemove && (
        <Button
          variant="icon"
          aria-label={removeLabel ?? "Remove"}
          onClick={onRemove}
          className="shrink-0 text-content-muted hover:text-content-secondary"
        >
          <ChipRemoveIcon />
        </Button>
      )}
    </span>
  );
}

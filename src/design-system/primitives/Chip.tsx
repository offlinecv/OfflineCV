// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

export type ChipTone = "neutral" | "success" | "warning";

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
}

export function Chip({ icon, children, tone = "neutral" }: ChipProps) {
  const toneCls =
    tone === "success"
      ? "bg-feedback-success-bg text-feedback-success-text"
      : tone === "warning"
        ? "bg-feedback-warning-bg text-feedback-warning-text"
        : "bg-surface-subtle text-content-secondary";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${toneCls}`}
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
    </span>
  );
}

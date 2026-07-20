// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

export type ChipTone = "neutral" | "success" | "warning";

interface ChipProps {
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
      {icon && <span>{icon}</span>}
      {children}
    </span>
  );
}

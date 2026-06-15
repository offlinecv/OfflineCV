// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * StatusBadge — shared pill for parse-status labels.
 *
 * Absorbs the local StatusPill that lived in Result.tsx (L45-63).
 * Sits alongside shared/Card.tsx in the shared-composed tier.
 *
 * Tones:
 *   ok      — green / success feedback tokens (e.g. "Parsed")
 *   limited — amber / warning feedback tokens (e.g. "Limited parsing")
 *   warning — alias for limited; kept for callsite clarity
 *
 * Design rules (CLAUDE.md): semantic tokens only.
 */

import type { ReactNode } from "react";

export type StatusBadgeTone = "ok" | "limited" | "warning";

interface StatusBadgeProps {
  tone: StatusBadgeTone;
  children: ReactNode;
}

const TONE_CLS: Record<StatusBadgeTone, string> = {
  ok: "bg-feedback-success-bg text-feedback-success-text",
  limited: "bg-feedback-warning-bg text-feedback-warning-text",
  warning: "bg-feedback-warning-bg text-feedback-warning-text",
};

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${TONE_CLS[tone]}`}
    >
      {children}
    </span>
  );
}

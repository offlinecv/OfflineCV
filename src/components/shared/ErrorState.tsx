// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ErrorState — inline error / warning banner.
 *
 * Absorbs the hardcoded-palette error block in App.tsx (L150-153):
 *   border-red-300 bg-red-50 text-red-900 dark:border-red-900 ...
 *
 * Uses feedback semantic tokens exclusively so dark-mode adapts automatically
 * without `dark:` overrides — same pattern as Result.tsx's feedback-* usage.
 *
 * Tones:
 *   error   — red feedback tokens (default; for parse failures, fatal errors)
 *   warning — amber feedback tokens (for recoverable / partial issues)
 *
 * Design rules (CLAUDE.md): semantic tokens only; no raw palette classes.
 */

import type { ReactNode } from "react";

export type ErrorStateTone = "error" | "warning";

interface ErrorStateProps {
  tone?: ErrorStateTone;
  children: ReactNode;
  /** Extra classes for layout (margin, width) — chrome stays here. */
  className?: string;
}

const TONE_CLS: Record<ErrorStateTone, string> = {
  error:
    "border-feedback-error-border bg-feedback-error-bg text-feedback-error-text",
  warning:
    "border-feedback-warning-border bg-feedback-warning-bg text-feedback-warning-text",
};

export function ErrorState({
  tone = "error",
  children,
  className,
}: ErrorStateProps) {
  const cls = [
    "rounded-lg border p-3 text-sm",
    TONE_CLS[tone],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <p className={cls}>{children}</p>;
}

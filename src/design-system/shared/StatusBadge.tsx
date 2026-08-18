// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 *   info    — blue / informational feedback tokens (e.g. "Recovered with on-device AI")
 *   neutral — subdued surface + muted content tokens, for a status that is
 *             ordinary rather than a problem (e.g. a JD requirement the résumé
 *             simply doesn't evidence). Added for #204's semantic verdict rows,
 *             where the three statuses must read as ONE badge family: "met" and
 *             "partial" already had tones, and giving "missing" a `warning`
 *             pill would frame every unmet requirement as a fault. The
 *             alternative — a bespoke pill at that one callsite — is the
 *             parallel copy the CLAUDE.md Golden Rule forbids, so the variant
 *             is added to the shared piece instead.
 *
 * Design rules (CLAUDE.md): semantic tokens only.
 */

import type { ReactNode } from "react";

export type StatusBadgeTone = "ok" | "limited" | "warning" | "info" | "neutral";

interface StatusBadgeProps {
  tone: StatusBadgeTone;
  children: ReactNode;
  /** Hide the badge from the accessibility tree — for a callsite where the
   *  badge's word is already spoken by adjacent text, so exposing it would
   *  announce the same word twice. Only ever safe when that duplicate exists;
   *  the badge is otherwise the only carrier of its status. */
  "aria-hidden"?: boolean;
}

const TONE_CLS: Record<StatusBadgeTone, string> = {
  ok: "bg-feedback-success-bg text-feedback-success-text",
  limited: "bg-feedback-warning-bg text-feedback-warning-text",
  warning: "bg-feedback-warning-bg text-feedback-warning-text",
  info: "bg-feedback-info-bg text-feedback-info-text",
  neutral: "bg-surface-subtle text-content-muted",
};

export function StatusBadge({
  tone,
  children,
  "aria-hidden": ariaHidden,
}: StatusBadgeProps) {
  return (
    <span
      aria-hidden={ariaHidden}
      className={`inline-flex w-fit rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${TONE_CLS[tone]}`}
    >
      {children}
    </span>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * InlineResult — feedback-toned result-strip chrome (rounded border +
 * feedback bg + tone). Distinct concern from Card's neutral surface panel
 * framing: InlineResult is used for outcome strips *inside* a feature panel
 * (e.g. a proposed rewrite result), never for top-level page cards.
 *
 * Layout (flex/gap) stays caller-side — pass via `className`.
 * Renders a `<div>` (not a landmark element) since these strips are
 * content within an already-structured section.
 */

import type { ReactNode } from "react";

const TONE_CHROME: Record<"success" | "warning", string> = {
  success: "rounded border border-feedback-success-border bg-feedback-success-bg p-3",
  warning: "rounded border border-feedback-warning-border bg-feedback-warning-bg p-3",
};

interface InlineResultProps {
  /** Feedback tone — controls border + background colour. */
  tone: "success" | "warning";
  children: ReactNode;
  /** Extra classes layered after the shared chrome — layout, gap, etc. */
  className?: string;
}

export function InlineResult({ tone, children, className }: InlineResultProps) {
  const chrome = TONE_CHROME[tone];
  const cls = className ? `${chrome} ${className}` : chrome;
  return <div className={cls}>{children}</div>;
}

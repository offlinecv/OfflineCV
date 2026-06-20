// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { PdfSection } from "../sections.ts";
import { isBulletLine } from "../line-primitives.ts";

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * Summary is a prose paragraph, usually 2–6 lines, right after the "Summary"
 * header. Conservative extractor — if we don't have a dedicated section, we
 * don't guess.
 */
export function extractSummary(
  summary: PdfSection | undefined,
): { value?: string; confidence: number } {
  if (!summary || summary.lines.length === 0) return { confidence: 0 };
  const prose = summary.lines
    .filter((l) => !isBulletLine(l))
    .map((l) => l.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!prose) return { confidence: 0 };
  // Penalize suspiciously short "summaries" (probably a tagline).
  const confidence = prose.length >= 60 ? 0.8 : prose.length >= 20 ? 0.5 : 0.2;
  return { value: prose, confidence };
}

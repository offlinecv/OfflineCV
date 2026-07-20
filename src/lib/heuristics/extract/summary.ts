// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import type { PdfLine, PdfSection } from "../sections.ts";

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * A summary bullet uses a glyph or hyphen/asterisk marker. Deliberately NARROWER
 * than the shared `isBulletLine`: it OMITS the en/em dashes (`–` `—`). A prose
 * summary can wrap such that a sentence-level dash lands at the start of a
 * continuation line (e.g. "…security engineering\n— proven in scaling…" — how
 * our own reconstructed-résumé renderer re-wraps a parenthetical). Treating that
 * line as a bullet silently truncates the summary on round-trip (#292); here we
 * keep it as prose. `isBulletLine` still owns dash-bulleted experience lines —
 * this stricter set is summary-local on purpose.
 */
const SUMMARY_BULLET_RE = /^\s*[•‣▪●◦⁃*\-]/;

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
    .filter((l: PdfLine) => !SUMMARY_BULLET_RE.test(l.text))
    .map((l) => l.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!prose) return { confidence: 0 };
  // Penalize suspiciously short "summaries" (probably a tagline).
  const confidence = prose.length >= 60 ? 0.8 : prose.length >= 20 ? 0.5 : 0.2;
  return { value: prose, confidence };
}

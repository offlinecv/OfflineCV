// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Leaf-level line primitives shared by the entry-block parser and the field
 * extractors: bullet detection/stripping and date-range parsing.
 *
 * These live in their own module to break the import cycle that arises when
 * `entry-blocks.ts` (the shared windowing primitive) and `extract-fields.ts`
 * (its caller) both need the same low-level helpers. This module depends only
 * on `regex.ts` constants and the `PdfLine` type — nothing in the heuristics
 * layer imports back into it — so it sits cleanly below both.
 */

import type { PdfLine } from "./sections.ts";
import { DATE_RANGE_RE, YEAR_RE } from "./regex.ts";

/** True if the line looks like a bullet point (starts with •, ‣, -, *, ◦, or is indented prose). */
export function isBulletLine(line: PdfLine): boolean {
  return /^\s*[•‣▪●◦⁃*\-–—]/.test(line.text);
}

/** Strip leading bullet glyphs + whitespace. */
export function stripBullet(text: string): string {
  return text.replace(/^\s*[•‣▪●◦⁃*\-–—]\s*/, "").trim();
}

/** Collapse internal whitespace and trim — the canonical date-token normalizer. */
export function normalizeDate(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Parse a date range (start/end) from a line. Tolerates M/YYYY, Mmm YYYY, YYYY. */
export function parseDateRange(text: string): {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
} {
  // Try the paired DATE_RANGE_RE first.
  const m = DATE_RANGE_RE.exec(text);
  DATE_RANGE_RE.lastIndex = 0;
  if (m) {
    const start = normalizeDate(m[1] ?? m[3]);
    const endRaw = m[2] ?? m[4];
    if (/^(present|current|now|ongoing)$/i.test(endRaw)) {
      return { start_date: start, is_current: true };
    }
    return { start_date: start, end_date: normalizeDate(endRaw) };
  }
  // Fall back to loose detection: first year.
  const year = YEAR_RE.exec(text);
  YEAR_RE.lastIndex = 0;
  if (year) return { start_date: year[0] };
  return {};
}

export function stripDateRange(text: string): string {
  // Remove the paired match and leftover year tokens.
  let cleaned = text.replace(DATE_RANGE_RE, "").trim();
  DATE_RANGE_RE.lastIndex = 0;
  cleaned = cleaned.replace(/\b(Present|Current|Now|Ongoing)\b/gi, "").trim();
  cleaned = cleaned.replace(YEAR_RE, "").trim();
  YEAR_RE.lastIndex = 0;
  cleaned = cleaned.replace(/^[-–—,|\s]+|[-–—,|\s]+$/g, "");
  return cleaned;
}

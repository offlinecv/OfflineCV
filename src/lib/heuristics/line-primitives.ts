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

/**
 * True when a line reads like a description sentence rather than an entry
 * header (company / title / institution). Some templates — notably the Word /
 * Office résumé templates — write the role description as a glyph-less prose
 * paragraph instead of a bulleted list, so `isBulletLine` alone can't tell the
 * description apart from the header lines around the date.
 *
 * Two signals, both required, plus a word floor:
 *   - a lowercase letter (a long ALL-CAPS company/title isn't prose), and
 *   - an INTERNAL sentence break ("…accomplishments. Where…") — a period
 *     between two letters followed by a capitalized word. This is what keeps a
 *     long-but-header line like "Acme Analytics (8 employee venture-backed
 *     startup) New York, NY" out: it has commas and parentheses but no
 *     sentence period, so it stays a header (and its company is preserved).
 * The 8-word floor sits just under the scorer's 8-30-word bullet window, so a
 * paragraph the scorer would grade as a bullet is captured as body here too.
 * Glyph-less descriptions WITHOUT a sentence period (e.g. indented one-line
 * bullets) are left to the bullet/indent path, unchanged by this predicate.
 */
const PROSE_MIN_WORDS = 8;
const SENTENCE_BREAK_RE = /[a-z]{2}\.\s+[A-Z]/;
export function isProseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!/[a-z]/.test(trimmed)) return false;
  if (!SENTENCE_BREAK_RE.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length >= PROSE_MIN_WORDS;
}

/** Collapse internal whitespace and trim — the canonical date-token normalizer. */
export function normalizeDate(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** True when a parsed date anchor is an unfilled Word/Office template placeholder
 *  ("Month Year", or a bare "Month"/"Year") rather than a real date. `DATE_RANGE_RE`
 *  admits these word placeholders so a template role still anchors/splits and the
 *  placeholder strips off the title — but the placeholder must NOT be recorded as a
 *  real date, or completeness would stop flagging the missing role dates. */
function isPlaceholderDate(token: string): boolean {
  return /^(?:month(?:\s+year)?|year)$/i.test(token.trim());
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
    // An unfilled template range ("Month Year - ...") matched only to anchor and
    // strip the role header — it carries no real date, so report none. (A real
    // start with a placeholder end still keeps the start; see below.)
    if (isPlaceholderDate(start)) return {};
    const endRaw = m[2] ?? m[4];
    if (/^(present|current|now|ongoing)$/i.test(endRaw)) {
      return { start_date: start, is_current: true };
    }
    const end = normalizeDate(endRaw);
    return isPlaceholderDate(end)
      ? { start_date: start }
      : { start_date: start, end_date: end };
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

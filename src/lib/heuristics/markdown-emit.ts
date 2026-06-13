// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * PDF → markdown emitter.
 *
 * Consumes `PdfTextItem[]` + `PdfPageInfo[]` from `pdf-extract.ts` and emits
 * a structure-preserving markdown rendering: `#`/`##`/`###` headings at
 * font-size thresholds relative to the document's modal body size, bulleted
 * lists when a line starts with a common bullet glyph, and plain prose
 * otherwise. Deterministic — no LLM involvement.
 *
 * Split into small utility functions so each concern can be unit-tested
 * independently: line grouping, body-font detection, bullet detection,
 * per-line rendering, paragraph separation.
 *
 * (Step 0 of the Canonical Document Ingestion epic). The cascade
 * invokes `emitMarkdown()` after `analyzeLayout` and attaches the result to
 * `CascadeResult.markdown`; downstream consumers (LLM prompts, section
 * splitters) read it when present and fall back to `rawText` when not.
 */

import type { PdfTextItem, PdfPageInfo } from "./types.ts";
import { orderItemsByColumn } from "./sections.ts";

// ── Thresholds (tuneable) ───────────────────────────────────────────────────

/** Ratio of line fontSize to body fontSize that promotes to `# H1`. */
const H1_RATIO = 1.5;
/** Ratio that promotes to `## H2`. */
const H2_RATIO = 1.25;
/** Ratio that promotes to `### H3`. */
const H3_RATIO = 1.12;

/** Same-line y-coord tolerance in PDF points. */
const SAME_LINE_Y_TOL = 1.5;

/** Gap larger than this (as a multiple of body size) inserts a blank line. */
const PARAGRAPH_GAP_RATIO = 1.5;

/** Font-size change ≥ this (in points) inserts a blank line. */
const FONT_CHANGE_TOL = 0.5;

/** Minimum number of lines before we bother emitting markdown. */
const MIN_LINES = 3;

/**
 * Bullet glyphs seen in PDF resumes. Includes common Unicode bullets, the
 * Wingdings 0xF0B7 used by some Word exports, and plain ASCII dashes.
 * A leading run of any of these (followed by whitespace) is treated as a
 * bullet prefix. The trailing `\s+` is required — a line starting with `*`
 * but no space is not a bullet.
 */
const LEADING_BULLET_RE =
  /^[\s]*[\u2022\u25AA\u25E6\u2023\u00B7\u2043\uF0B7\u2219\u25CF\u2B24\u25B8\u25B6*\-]\s+/;

// ── Types ───────────────────────────────────────────────────────────────────

/** A single logical line produced by grouping items at matching y-coords. */
export interface PdfLine {
  page: number;
  y: number;
  /** Leftmost x of any item in this line (for future indentation logic). */
  x: number;
  /** Concatenated text of all items on this line, trimmed. */
  text: string;
  /** Max font size across items in the line — the signal for heading promotion. */
  fontSize: number;
}

// ── Utilities (exported for testing) ────────────────────────────────────────

/**
 * Group positioned text items into logical lines. Items on the same page
 * with y within `SAME_LINE_Y_TOL` merge into one line, sorted by x.
 * Returns lines in page-then-y (top-down) order.
 *
 * When `boundaries` (the per-page column split-x map) is present, items are
 * first split into column bands via `orderItemsByColumn`, so a two-column
 * layout's left column is emitted entirely before its right column instead of
 * being interleaved row-by-row. Single-column input yields one band, leaving
 * the output identical to the pre-column-aware behavior.
 */
export function groupItemsIntoLines(
  items: PdfTextItem[],
  boundaries?: Map<number, number>,
): PdfLine[] {
  const bands = orderItemsByColumn(items, boundaries);
  return bands.flatMap(groupLinesSingle);
}

/** Single-pass line grouping over one band of items (no column awareness). */
function groupLinesSingle(items: PdfTextItem[]): PdfLine[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > SAME_LINE_Y_TOL) return a.y - b.y;
    return a.x - b.x;
  });

  const lines: PdfLine[] = [];
  let current: PdfLine | null = null;

  for (const item of sorted) {
    if (!item.str) continue;
    const sameLine =
      current !== null &&
      current.page === item.page &&
      Math.abs(current.y - item.y) <= SAME_LINE_Y_TOL;

    if (sameLine && current) {
      current.text += item.str;
      current.fontSize = Math.max(current.fontSize, item.fontSize);
      current.x = Math.min(current.x, item.x);
    } else {
      if (current && current.text.trim()) lines.push(current);
      current = {
        page: item.page,
        y: item.y,
        x: item.x,
        text: item.str,
        fontSize: item.fontSize,
      };
    }
  }
  if (current && current.text.trim()) lines.push(current);

  return lines
    .map((l) => ({ ...l, text: l.text.trim() }))
    .filter((l) => l.text.length > 0);
}

/**
 * Compute the body font size as the character-weighted mode of font sizes
 * across all lines. Weighting by character count (rather than line count)
 * makes us robust to headers that span multiple short lines — the long
 * body paragraphs still dominate the mode.
 *
 * Returns the default 10pt when given no lines. Bins sizes to 0.1pt to
 * collapse near-equal floats that pdfjs sometimes emits.
 */
export function computeBodyFontSize(lines: PdfLine[]): number {
  if (lines.length === 0) return 10;

  const bins = new Map<number, number>();
  for (const line of lines) {
    const bin = Math.round(line.fontSize * 10) / 10;
    bins.set(bin, (bins.get(bin) ?? 0) + line.text.length);
  }

  let mode = 10;
  let maxChars = 0;
  for (const [size, chars] of bins.entries()) {
    if (chars > maxChars) {
      maxChars = chars;
      mode = size;
    }
  }
  return mode;
}

/** True if the line begins with a bullet glyph + whitespace. */
export function isBulletLine(text: string): boolean {
  return LEADING_BULLET_RE.test(text);
}

/** Strip a leading bullet glyph + whitespace. Idempotent. */
export function stripBulletPrefix(text: string): string {
  return text.replace(LEADING_BULLET_RE, "").trim();
}

/**
 * Render a single line to markdown: heading by font-size ratio, bullet by
 * leading glyph, plain prose otherwise.
 */
export function renderLine(line: PdfLine, bodySize: number): string {
  const ratio = line.fontSize / bodySize;
  if (ratio >= H1_RATIO) return `# ${line.text}`;
  if (ratio >= H2_RATIO) return `## ${line.text}`;
  if (ratio >= H3_RATIO) return `### ${line.text}`;
  if (isBulletLine(line.text)) return `- ${stripBulletPrefix(line.text)}`;
  return line.text;
}

/**
 * True when a blank line should be inserted between `prev` and `next`:
 * page break, large vertical gap, or font-size change (header transition).
 */
export function needsParagraphBreak(
  prev: PdfLine,
  next: PdfLine,
  bodySize: number,
): boolean {
  if (prev.page !== next.page) return true;
  const yGap = next.y - prev.y;
  if (yGap > bodySize * PARAGRAPH_GAP_RATIO) return true;
  // y jumping backward within a page marks a left→right column-band transition
  // (the left band ends near the page bottom; the right band restarts at the
  // top). Insert a blank line so the right column's first heading isn't fused
  // onto the left column's last line. Single-column input has monotonically
  // increasing y, so this never fires there.
  if (next.y < prev.y - bodySize) return true;
  const fontChanged = Math.abs(prev.fontSize - next.fontSize) > FONT_CHANGE_TOL;
  if (fontChanged) return true;
  return false;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Emit structure-preserving markdown from positioned PDF text items.
 *
 * Returns `undefined` when the input is too sparse to produce useful
 * structure (fewer than `MIN_LINES` lines after grouping). Callers fall
 * back to `rawText` on undefined.
 */
export function emitMarkdown(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
  boundaries?: Map<number, number>,
): string | undefined {
  if (items.length === 0 || pages.length === 0) return undefined;

  const lines = groupItemsIntoLines(items, boundaries);
  if (lines.length < MIN_LINES) return undefined;

  const bodySize = computeBodyFontSize(lines);

  const output: string[] = [];
  let prev: PdfLine | null = null;

  for (const line of lines) {
    const rendered = renderLine(line, bodySize);
    if (prev && needsParagraphBreak(prev, line, bodySize)) {
      output.push("");
    }
    output.push(rendered);
    prev = line;
  }

  // Collapse runs of 3+ blank lines — happens around page breaks combined
  // with font transitions. Two blank lines = one empty paragraph; three
  // blank lines adds nothing.
  const joined = output.join("\n").replace(/\n{3,}/g, "\n\n");
  return joined.trim();
}

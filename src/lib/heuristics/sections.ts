// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Group positional PDF items into logical "lines" and "sections".
 *
 * PDF coordinates are bottom-origin (y grows upward). We flip once at
 * extraction time so the rest of the pipeline sees top-origin coordinates
 * (y grows downward) — consistent with how readers actually scan.
 *
 * A "line" is a cluster of items whose y-centers agree within `LINE_Y_EPS`
 * *and* that share a page. A "section" is a contiguous run of lines that
 * share a canonical header name ("experience", "education", etc.) — plus
 * an implicit `profile` section at the top before the first header.
 */

import type { PdfTextItem } from "./types.ts";
import { matchSectionHeader, type SectionName } from "./regex.ts";

export interface PdfLine {
  page: number;
  /** Line's representative y (average of item y-centers). */
  y: number;
  /** Left-most item x on the line. */
  x: number;
  /** Items sorted left-to-right. */
  items: PdfTextItem[];
  /** Concatenated text with spaces between runs. */
  text: string;
  /** Max fontSize across items — drives name / header detection. */
  maxFontSize: number;
  /** True if every item on the line is all-caps (names + headers). */
  allCaps: boolean;
}

export interface PdfSection {
  /** "profile" covers anything above the first recognized header. */
  name: SectionName | "profile";
  lines: PdfLine[];
}

/** Items within this vertical distance (PDF points) are treated as same line. */
const LINE_Y_EPS = 3.5;

// ── Line grouping ───────────────────────────────────────────────────────────

export function groupIntoLines(items: PdfTextItem[]): PdfLine[] {
  // Sort by page, then by y (top to bottom), then by x (left to right).
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > LINE_Y_EPS) return a.y - b.y;
    return a.x - b.x;
  });

  const lines: PdfLine[] = [];
  let current: PdfTextItem[] = [];

  const flush = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    const text = mergeItemText(current);
    const ys = current.map((i) => i.y);
    const avgY = ys.reduce((a, b) => a + b, 0) / ys.length;
    lines.push({
      page: current[0].page,
      y: avgY,
      x: current[0].x,
      items: [...current],
      text,
      maxFontSize: Math.max(...current.map((i) => i.fontSize)),
      allCaps: text.replace(/[^A-Za-z]/g, "").length > 0 && text === text.toUpperCase(),
    });
    current = [];
  };

  for (const item of sorted) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    const last = current[current.length - 1];
    const sameLine = item.page === last.page && Math.abs(item.y - last.y) <= LINE_Y_EPS;
    if (sameLine) {
      current.push(item);
    } else {
      flush();
      current.push(item);
    }
  }
  flush();

  return lines;
}

/**
 * Concatenate items on a line, inserting a space when the horizontal gap
 * between runs is large enough to imply a word boundary. pdfjs emits each
 * glyph run as a separate item, so naively joining with spaces over-pads
 * and joining without spaces under-pads.
 */
function mergeItemText(items: PdfTextItem[]): string {
  if (items.length === 0) return "";
  let out = items[0].str;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const gap = cur.x - (prev.x + prev.width);
    const avgCharW = prev.width / Math.max(prev.str.length, 1);
    // Gap wider than ~half a character triggers an inserted space.
    // Also always insert a space if either side already has trailing/leading ws.
    const prevEndsWs = /\s$/.test(prev.str);
    const curStartsWs = /^\s/.test(cur.str);
    const needSpace = !prevEndsWs && !curStartsWs && gap > avgCharW * 0.4;
    out += (needSpace ? " " : "") + cur.str;
  }
  return out.replace(/\s+/g, " ").trim();
}

// ── Section splitting ───────────────────────────────────────────────────────

/**
 * Scan the lines top-to-bottom, mark lines that match a canonical section
 * header, and bucket everything between headers. Content above the first
 * header lands in the synthetic `profile` section.
 */
export function splitIntoSections(lines: PdfLine[]): PdfSection[] {
  const sections: PdfSection[] = [{ name: "profile", lines: [] }];

  for (const line of lines) {
    const header = matchSectionHeader(line.text);
    if (header) {
      sections.push({ name: header, lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }

  return sections;
}

/** Helper: lookup a section by name. Returns undefined if absent. */
export function findSection(
  sections: PdfSection[],
  name: SectionName | "profile",
): PdfSection | undefined {
  return sections.find((s) => s.name === name);
}

// ── Markdown-anchored section splitting ──────────────────────────

/**
 * ATX heading at the start of a line — captures the heading payload. The
 * PDF markdown emitter (`markdown-emit.ts`) promotes lines to `#`/`##`/`###`
 * based on font-size ratio, so every heading we match here corresponds to
 * a line that cleared the promotion gate in the original PDF.
 */
const MARKDOWN_HEADING_RE = /^\s*#{1,3}\s+(.+?)\s*#*\s*$/;

/**
 * Split `lines` into sections using the markdown's heading structure as the
 * boundary signal, rather than running `matchSectionHeader` against every
 * line. Returns `null` when the markdown yielded fewer than two canonical
 * sections — the caller falls back to the regex-on-line splitter.
 *
 * Why this is tighter than the regex-on-line splitter: the line splitter
 * matches *any* line whose text equals a section keyword (e.g. a line that
 * just says "Skills" in the middle of a profile paragraph would open a new
 * section). The markdown splitter only treats a line as a header when the
 * PDF markdown emitter already promoted it via font-size ratio — filtering
 * out the body-font-size false positives the line splitter cannot avoid.
 *
 * Matching is done by normalized text equality between the markdown heading
 * payload and the PDF line text. Both sides are trimmed and lowercased and
 * have trailing `:` / `·` / `•` stripped (mirroring `matchSectionHeader`).
 * Lines without a corresponding markdown-heading match fall into the
 * current section.
 */
export function splitIntoSectionsWithMarkdown(
  lines: PdfLine[],
  markdown: string,
): PdfSection[] | null {
  const headerTexts = extractCanonicalHeadingTexts(markdown);
  if (headerTexts.size === 0) return null;

  const sections: PdfSection[] = [{ name: "profile", lines: [] }];
  for (const line of lines) {
    const key = normalizeHeaderText(line.text);
    const section = headerTexts.get(key);
    if (section && matchSectionHeader(line.text) === section) {
      sections.push({ name: section, lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }

  // Count only non-profile sections — a markdown with zero canonical
  // headings that somehow survived the empty-map check still falls back.
  const canonicalCount = sections.filter((s) => s.name !== "profile").length;
  if (canonicalCount < 2) return null;

  return sections;
}

/**
 * Scan a markdown document for `#`/`##`/`###` headings whose payload matches
 * a canonical section keyword. Returns a `normalizedText → SectionName` map
 * so the splitter can look up each PDF line by its own normalized text.
 *
 * Duplicates (same heading text appearing twice, e.g. two "EDUCATION"
 * headings) collapse to a single entry; the splitter opens a new section
 * each time it sees the normalized text on a PDF line, so both PDF-side
 * occurrences still produce section breaks.
 */
function extractCanonicalHeadingTexts(
  markdown: string,
): Map<string, SectionName> {
  const out = new Map<string, SectionName>();
  const rawLines = markdown.split(/\r?\n/);
  for (const raw of rawLines) {
    const m = MARKDOWN_HEADING_RE.exec(raw);
    if (!m) continue;
    const payload = m[1];
    const section = matchSectionHeader(payload);
    if (!section) continue;
    out.set(normalizeHeaderText(payload), section);
  }
  return out;
}

/**
 * Normalize a candidate heading text for equality comparison. Mirrors the
 * pre-matching normalization in `matchSectionHeader` (trim, lowercase,
 * strip trailing `:` / `·` / `•`) so both sides collide when equivalent.
 */
function normalizeHeaderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[:·•]+$/, "")
    .trim();
}

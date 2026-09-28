// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PDF → markdown emitter.
 *
 * Renders the parser's assembled `PdfLine[]` as structure-preserving markdown:
 * `#`/`##`/`###` headings at font-size thresholds relative to the document's
 * modal body size, bulleted lists when a line starts with a common bullet
 * glyph, and plain prose otherwise. Deterministic — no LLM involvement.
 *
 * The constraint this module guards (#651): the emitter must see the SAME
 * `PdfLine` objects the section splitter sees. It used to assemble lines from
 * raw items with a private grouper (tighter y-tolerance, no inferred spaces,
 * no letter-spacing collapse, no column-gap split), and the markdown-anchored
 * splitter then matched its headings back to the parser's lines by normalized
 * text. Any assembly disagreement on a heading row — a tracked-out
 * `S K I L L S`, a heading whose word gap needed an inferred space, a heading
 * sharing a baseline with a right-column value — silently demoted the whole
 * document to the regex splitter. Now `emitMarkdownFromLines` takes the
 * parser's lines and returns, alongside the markdown, the exact line objects
 * it promoted; `splitIntoSectionsWithMarkdown` opens sections by identity.
 *
 * `parseHeuristic` (`openresume.ts`) is the production caller; it attaches the
 * markdown to `HeuristicResult.markdown`, which the cascade carries onto
 * `CascadeResult.markdown` for the on-device LLM prompts and the header
 * oracle. `emitMarkdown` remains as a convenience over raw items for callers
 * outside the cascade.
 *
 * Split into small utility functions so each concern can be unit-tested
 * independently: body-font detection, bullet detection, per-line rendering,
 * paragraph separation.
 */

import type { PdfTextItem, PdfPageInfo } from "./types.ts";
import type { PdfLine } from "./line-model.ts";
import { computeBodyFontSize, groupIntoLines } from "./line-assembly.ts";

// ── Thresholds (tuneable) ───────────────────────────────────────────────────

/** Ratio of line font size to body font size that promotes to `# H1`. */
const H1_RATIO = 1.5;
/** Ratio that promotes to `## H2`. */
const H2_RATIO = 1.25;
/** Ratio that promotes to `### H3`. */
const H3_RATIO = 1.12;

/** Gap larger than this (as a multiple of body size) inserts a blank line. */
const PARAGRAPH_GAP_RATIO = 1.5;

/** Font-size change ≥ this (in points) inserts a blank line. */
const FONT_CHANGE_TOL = 0.5;

/** Minimum number of non-empty lines before we bother emitting markdown. */
const MIN_LINES = 3;

/**
 * Bullet glyphs seen in PDF resumes. Includes common Unicode bullets, the
 * Wingdings 0xF0B7 used by some Word exports, and plain ASCII dashes.
 * A leading run of any of these (followed by whitespace) is treated as a
 * bullet prefix. The trailing `\s+` is required — a line starting with `*`
 * but no space is not a bullet.
 */
const LEADING_BULLET_RE =
  /^[\s]*[•▪◦‣·⁃∙●⬤▸▶*\-]\s+/;

// ── Types ───────────────────────────────────────────────────────────────────

/** What `emitMarkdownFromLines` hands back: the rendering plus its evidence. */
export interface MarkdownEmission {
  /** The rendered markdown document. */
  markdown: string;
  /**
   * The `PdfLine` objects rendered as `#`/`##`/`###` headings — the very
   * objects from the input array, so a consumer holding the same array can
   * test membership by identity rather than by re-deriving text. This is the
   * contract `splitIntoSectionsWithMarkdown` relies on (#651).
   */
  headings: ReadonlySet<PdfLine>;
}

// ── Utilities (exported for testing) ────────────────────────────────────────

/** True if the line begins with a bullet glyph + whitespace. */
export function isBulletLine(text: string): boolean {
  return LEADING_BULLET_RE.test(text);
}

/** Strip a leading bullet glyph + whitespace. Idempotent. */
export function stripBulletPrefix(text: string): string {
  return text.replace(LEADING_BULLET_RE, "").trim();
}

/** Heading level a line renders at, or 0 for body/bullet — by font ratio. */
function headingLevel(line: PdfLine, bodySize: number): 0 | 1 | 2 | 3 {
  const ratio = line.maxFontSize / bodySize;
  if (ratio >= H1_RATIO) return 1;
  if (ratio >= H2_RATIO) return 2;
  if (ratio >= H3_RATIO) return 3;
  return 0;
}

/**
 * Render a single line to markdown: heading by font-size ratio, bullet by
 * leading glyph, plain prose otherwise.
 */
export function renderLine(line: PdfLine, bodySize: number): string {
  const level = headingLevel(line, bodySize);
  if (level > 0) return `${"#".repeat(level)} ${line.text}`;
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
  const fontChanged =
    Math.abs(prev.maxFontSize - next.maxFontSize) > FONT_CHANGE_TOL;
  if (fontChanged) return true;
  return false;
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Emit structure-preserving markdown from the parser's assembled lines.
 *
 * Lines with empty text are skipped (the shared assembler keeps a line for a
 * whitespace-only item; the rendering has nothing to say about it) and do not
 * count toward `MIN_LINES`. Returns `undefined` when the input is too sparse
 * to produce useful structure — callers fall back to `rawText` and the
 * section splitter falls back to its regex path.
 */
export function emitMarkdownFromLines(
  lines: readonly PdfLine[],
): MarkdownEmission | undefined {
  const visible = lines.filter((l) => l.text.length > 0);
  if (visible.length < MIN_LINES) return undefined;

  const bodySize = computeBodyFontSize(visible);
  const headings = new Set<PdfLine>();
  const output: string[] = [];
  let prev: PdfLine | null = null;

  for (const line of visible) {
    if (headingLevel(line, bodySize) > 0) headings.add(line);
    if (prev && needsParagraphBreak(prev, line, bodySize)) {
      output.push("");
    }
    output.push(renderLine(line, bodySize));
    prev = line;
  }

  // Collapse runs of 3+ blank lines — happens around page breaks combined
  // with font transitions. Two blank lines = one empty paragraph; three
  // blank lines adds nothing.
  const markdown = output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, headings };
}

/**
 * Convenience over raw positioned items: assemble lines with the shared
 * assembler, then emit. For callers outside the cascade that hold their own
 * `PdfTextItem[]`; inside the cascade, `parseHeuristic` calls
 * `emitMarkdownFromLines` on the lines it already built so the splitter and
 * the emitter share objects.
 */
export function emitMarkdown(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
  boundaries?: Map<number, number>,
): string | undefined {
  if (items.length === 0 || pages.length === 0) return undefined;
  return emitMarkdownFromLines(groupIntoLines(items, boundaries))?.markdown;
}

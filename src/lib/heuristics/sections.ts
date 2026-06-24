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
import { mergeWrappedContinuations } from "./entry-blocks.ts";
import {
  matchSectionHeader,
  matchSectionAnchorToken,
  EMAIL_RE,
  PHONE_RE,
  LINKEDIN_RE,
  type SectionName,
} from "./regex.ts";

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

/**
 * Typed, scorer-facing view of the detected section structure (spike #127 §2.1,
 * issue #132). Promotes the `PdfSection[]` the cascade already computes into a
 * minimal contract: section name → trimmed, non-empty text lines, in document
 * order. The pure scorer reads this instead
 * of receiving a hand-serialized `skillsSectionText` slice, so the cascade is
 * the single source of truth for "which lines belong to which section" and we
 * never add a per-bug side-channel again.
 *
 * Kept dependency-light on purpose: `ReadonlyMap<name, string[]>` rather than
 * `PdfSection[]`, so `score.ts` need not import `PdfLine`/`PdfTextItem`
 * geometry types.
 */
export interface SectionedResume {
  /** Section name → trimmed, non-empty text lines, in document order.
   *  "profile" (anything above the first header) is included so contact/name
   *  consumers can share the same view. */
  readonly byName: ReadonlyMap<SectionName | "profile", readonly string[]>;
  /** Sections whose lines pool into the experience-bullet set, in canonical
   *  policy order. A convenience accessor over `byName` for the scorer; not yet
   *  consumed by the pool sourcing (that is the next issue — see #132 Notes). */
  readonly accomplishmentSections: readonly SectionName[];
  /** Which splitter produced the section boundaries — provenance for
   *  confidence tuning / telemetry. */
  readonly source: "markdown" | "regex";
}

/** Canonical policy: these sections contribute experience-bullet lines. Encoded
 *  once here rather than duplicated across the authed/anonymous scorers. */
export const ACCOMPLISHMENT_SECTION_NAMES: readonly SectionName[] = [
  "experience",
  "projects",
  "achievements",
];

/**
 * Build the typed {@link SectionedResume} view from the raw `PdfSection[]` the
 * heuristic parser holds. Each section's lines are trimmed and emptied-out,
 * exactly as the retired `skillsSectionLines` slice was
 * (`lines.map(l => l.text.trim()).filter(t => t.length > 0)`) — so the
 * skills-exclusion set the scorer derives is byte-for-byte what it derived from
 * `skillsSectionText`, keeping the corpus goldens unchanged (#132).
 */
export function toSectionedResume(
  sections: PdfSection[],
  source: "markdown" | "regex",
): SectionedResume {
  // Accumulate (don't overwrite) when a name repeats — a resume can split one
  // logical section across continuation headers, and `findSection` flattened
  // all matches' lines in document order. Mirroring that here keeps
  // `byName.get("skills")` byte-identical to the retired `skillsSectionLines`.
  const byName = new Map<SectionName | "profile", string[]>();
  for (const section of sections) {
    // Fold wrapped-continuation lines (a long bullet that wrapped onto a
    // second, marker-less line indented past the bullet marker) into the line
    // they continue BEFORE flattening to strings — the x the fold needs is gone
    // once these are trimmed text. This makes the string-level bullet pool
    // (`extractBulletsFromLines`, which drops a glyph-less continuation as
    // truncation) agree by construction with the merged
    // `experience[]/projects[].description` the entry-block parser produces, for
    // every section incl. untyped ones (volunteer/coursework). See #162.
    const lines = mergeWrappedContinuations(section.lines)
      .map((l) => l.text.trim())
      .filter((t) => t.length > 0);
    const existing = byName.get(section.name);
    if (existing) existing.push(...lines);
    else byName.set(section.name, lines);
  }
  return {
    byName,
    accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
    source,
  };
}

/** Items within this vertical distance (PDF points) are treated as same line. */
const LINE_Y_EPS = 3.5;

/**
 * Horizontal gap inside a same-y cluster that flags a column boundary.
 * Awesome-CV / single-column LaTeX exports produce essentially 0pt gaps
 * between adjacent items even across `\hfill` alignment, so 50pt is well
 * above any in-line word/run spacing while comfortably below the column
 * gaps observed in real two-column resumes (Deedy's experience column
 * jumps in at ~70pt past the education column edge). Splitting at this
 * threshold rescues the bullet count on two-column layouts that don't
 * trigger the `two_column` layout flag (asymmetric 0.33/0.66 splits
 * like Deedy's slip past `probeTwoColumn`). Issue #9.
 */
const COLUMN_GAP_THRESHOLD = 50;

// ── Column banding ──────────────────────────────────────────────────────────

/**
 * Split items into reading-order "bands" so line grouping never interleaves a
 * two-column layout's left and right columns.
 *
 * `boundaries` is the per-page split-x map from `detectColumnBoundaries`.
 *   - undefined / empty  → a single band `[items]`. The downstream grouper
 *     then runs over every item exactly as it did before column-awareness, so
 *     the single-column output is byte-identical.
 *   - present            → bands are emitted page-major, ascending page order,
 *     and within a split page the **entire left column precedes the entire
 *     right column** (`item.x < split` → left, else right). A page without a
 *     split contributes one band of all its items. Same-line clustering never
 *     crosses pages, so per-page banding concatenated equals the old global
 *     grouping whenever no page splits.
 */
export function orderItemsByColumn(
  items: PdfTextItem[],
  boundaries: Map<number, number> | undefined,
): PdfTextItem[][] {
  if (!boundaries || boundaries.size === 0) return [items];

  // Group by page, preserving ascending page order.
  const byPage = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    const arr = byPage.get(it.page);
    if (arr) arr.push(it);
    else byPage.set(it.page, [it]);
  }
  const pageNums = [...byPage.keys()].sort((a, b) => a - b);

  const bands: PdfTextItem[][] = [];
  for (const page of pageNums) {
    const pageItems = byPage.get(page)!;
    const split = boundaries.get(page);
    if (split === undefined) {
      bands.push(pageItems);
      continue;
    }
    const left: PdfTextItem[] = [];
    const right: PdfTextItem[] = [];
    for (const it of pageItems) {
      if (it.x < split) left.push(it);
      else right.push(it);
    }
    // Left band before right band; skip empty bands so a near-empty side
    // doesn't emit a spurious blank grouping pass.
    if (left.length > 0) bands.push(left);
    if (right.length > 0) bands.push(right);
  }
  return bands;
}

// ── Localized multi-column reading-order reconstruction (#164) ───────────────

/**
 * Minimum number of consecutive multi-column rows for a run to count as a real
 * embedded multi-column band. One isolated multi-column row is the common
 * single-column case — a header line with a right-aligned date rail, a
 * "Title  …  dates" line — not a column block, so a single row never triggers
 * the reorder. A genuine coursework/skills grid runs ≥2 rows deep.
 */
const MULTI_COLUMN_MIN_RUN_ROWS = 2;

/** A row is "multi-column" when its x-sorted items carry a column-sized
 *  horizontal gap (the same `COLUMN_GAP_THRESHOLD` the line splitter uses). */
function rowIsMultiColumn(row: PdfTextItem[]): boolean {
  if (row.length < 2) return false;
  const sorted = [...row].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const gap = sorted[i].x - (prev.x + prev.width);
    if (gap > COLUMN_GAP_THRESHOLD) return true;
  }
  return false;
}

/**
 * Cluster a run's items into vertical columns by x-start. Sort the distinct
 * x-starts ascending and cut a new column wherever the jump between adjacent
 * starts exceeds `COLUMN_GAP_THRESHOLD`. A wrapped continuation (e.g. a course
 * name's second line, indented a few points past its bullet marker) lands in
 * the same column as its parent because its x sits inside that column's band,
 * far from the next column's start. Returns the column-start x boundaries (the
 * left edge of each column), ascending.
 */
function columnStartsForRun(run: PdfTextItem[]): number[] {
  const xs = [...new Set(run.map((it) => it.x))].sort((a, b) => a - b);
  const starts: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i === 0 || xs[i] - xs[i - 1] > COLUMN_GAP_THRESHOLD) starts.push(xs[i]);
  }
  return starts;
}

/** Index of the column an item belongs to: the last column-start at or left of
 *  the item's x (continuations indented within a column band stay in it). */
function columnIndexOf(x: number, starts: number[]): number {
  let idx = 0;
  for (let i = 0; i < starts.length; i++) {
    if (x >= starts[i] - 0.5) idx = i;
    else break;
  }
  return idx;
}

/**
 * Reorder the items of a single same-page band so that any *embedded*
 * multi-column block (e.g. a 3-column "Relevant Coursework" grid sitting inside
 * an otherwise single-column page) reads column-by-column instead of zig-zag
 * row-by-row.
 *
 * Why here and not the page-level column probe: `detectColumnBoundaries`
 * (`pdf-layout.ts`) is a *page-wide* vertical ink projection — it only fires
 * when a gutter runs the full height of the page, so a localized few-row grid
 * inside single-column body text is invisible to it (the body inks straight
 * across the grid's gutters). This pass works at the item level over one band,
 * detecting contiguous runs of column-split rows and emitting each run's items
 * in column-major (left column top-to-bottom, then the next) order. Everything
 * outside such a run passes through in its original order, so single-column
 * input and already-banded page-level two-column input are untouched — within
 * an `orderItemsByColumn` band there is only one column, hence no multi-column
 * row and no run.
 *
 * Operates per page (a band is single-page after `orderItemsByColumn`, but the
 * top-level rawText path groups all items at once, so guard on page anyway).
 * Runs BEFORE line grouping / sectionizing / `mergeWrappedContinuations`, so
 * those later passes see the corrected column order (#162 ordering constraint).
 */
function reorderEmbeddedColumns(items: PdfTextItem[]): PdfTextItem[] {
  // Baseline line order (page-major, then y top-to-bottom, then x left-to-right)
  // — what `groupLinesSingle` used to compute itself. We now own the ordering so
  // a reordered multi-column run survives to line grouping; the single-column /
  // already-banded case returns this sorted baseline unchanged.
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > LINE_Y_EPS) return a.y - b.y;
    return a.x - b.x;
  });
  if (sorted.length < 2 * MULTI_COLUMN_MIN_RUN_ROWS) return sorted;

  const rows = groupItemsIntoRows(sorted);
  const multi = rows.map(rowIsMultiColumn);
  let changed = false;
  const out: PdfTextItem[] = [];
  for (let i = 0; i < rows.length; ) {
    if (!multi[i]) {
      out.push(...rows[i]);
      i++;
      continue;
    }
    // Extend a maximal run of consecutive multi-column rows, then either reorder
    // it column-major or pass it through unchanged (run too short / one column).
    let j = i;
    while (j < rows.length && multi[j]) j++;
    const reordered = reorderColumnRun(rows.slice(i, j));
    out.push(...reordered.items);
    changed ||= reordered.changed;
    i = j;
  }

  return changed ? out : sorted;
}

/** Group y-sorted items into rows: contiguous items sharing a page and baseline
 *  (within `LINE_Y_EPS`) form one row, so a run is a contiguous slice of rows. */
function groupItemsIntoRows(sorted: PdfTextItem[]): PdfTextItem[][] {
  const rows: PdfTextItem[][] = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (
      last &&
      last[0].page === it.page &&
      Math.abs(last[0].y - it.y) <= LINE_Y_EPS
    ) {
      last.push(it);
    } else {
      rows.push([it]);
    }
  }
  return rows;
}

/** Reorder one maximal run of multi-column rows into column-major order. Returns
 *  the run unchanged (`changed:false`) when it's too short to be a real grid or
 *  resolves to a single column; otherwise buckets items by column (each column
 *  top-to-bottom, since `runItems` already ascend by y) and emits column-major. */
function reorderColumnRun(runRows: PdfTextItem[][]): {
  items: PdfTextItem[];
  changed: boolean;
} {
  const runItems = runRows.flat();
  const starts =
    runRows.length < MULTI_COLUMN_MIN_RUN_ROWS
      ? []
      : columnStartsForRun(runItems);
  if (starts.length < 2) return { items: runItems, changed: false };

  const buckets: PdfTextItem[][] = starts.map(() => []);
  for (const it of runItems) buckets[columnIndexOf(it.x, starts)].push(it);
  return { items: buckets.flat(), changed: true };
}

// ── Line grouping ───────────────────────────────────────────────────────────

export function groupIntoLines(
  items: PdfTextItem[],
  boundaries?: Map<number, number>,
): PdfLine[] {
  const bands = orderItemsByColumn(items, boundaries);
  return bands.flatMap(groupLinesSingle);
}

/** Single-pass line grouping over one band of items (no column awareness). */
function groupLinesSingle(bandItems: PdfTextItem[]): PdfLine[] {
  // De-interleave any embedded multi-column block (e.g. a coursework grid) so
  // its items read column-by-column before we cluster into lines (#164). A
  // no-op for single-column input and for already-banded page-level two-column
  // input — neither carries a multi-row column-split run within a band.
  // `reorderEmbeddedColumns` returns items already in line order (page-major,
  // y top-to-bottom, x left-to-right) — with any embedded multi-column run
  // rewritten to column-major. We must NOT re-sort here: a global (y, x) sort
  // would re-interleave the very columns we just de-zig-zagged. The streaming
  // grouper below flushes on any y change, so it clusters this order correctly
  // even where a column-major run jumps y backward at a column boundary.
  const sorted = reorderEmbeddedColumns(bandItems);

  const lines: PdfLine[] = [];
  let current: PdfTextItem[] = [];

  /** Build a PdfLine from a contiguous run of items (already x-sorted). */
  const buildLine = (run: PdfTextItem[]): PdfLine => {
    const text = mergeItemText(run);
    const ys = run.map((i) => i.y);
    const avgY = ys.reduce((a, b) => a + b, 0) / ys.length;
    return {
      page: run[0].page,
      y: avgY,
      x: run[0].x,
      items: [...run],
      text,
      maxFontSize: Math.max(...run.map((i) => i.fontSize)),
      allCaps: text.replace(/[^A-Za-z]/g, "").length > 0 && text === text.toUpperCase(),
    };
  };

  const flush = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    // Split the same-y cluster at column-sized horizontal gaps so two-column
    // layouts that share a baseline don't get merged into one PdfLine — see
    // COLUMN_GAP_THRESHOLD and issue #9.
    let runStart = 0;
    for (let i = 1; i < current.length; i++) {
      const prev = current[i - 1];
      const cur = current[i];
      const gap = cur.x - (prev.x + prev.width);
      if (gap > COLUMN_GAP_THRESHOLD) {
        lines.push(buildLine(current.slice(runStart, i)));
        runStart = i;
      }
    }
    lines.push(buildLine(current.slice(runStart)));
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
export function mergeItemText(items: PdfTextItem[]): string {
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

// ── Visual-header detection (L3 / #112) ─────────────────────────────────────

/**
 * Font-size ratio (line `maxFontSize` ÷ document body baseline) at which a line
 * is "meaningfully larger" than body text and therefore visually a header.
 *
 * Sits deliberately between the markdown emitter's `H3_RATIO` (1.12) and
 * `H2_RATIO` (1.25): a job title or company name rendered bold but only
 * slightly larger than body (≈1.05–1.15×) must NOT promote to a boundary, or it
 * would split mid-experience and strand every following role into the `other`
 * sink. 1.15 clears the slightly-bold-title FP class (≈1.1× titles) while still
 * catching the genuinely-larger invented-label headers ("Career Journey") this
 * path exists to segment.
 *
 * Lowered 1.2 → 1.15 in #163: the Skia/Chrome renderer (Google Docs → PDF)
 * flattens an h2 down to ≈1.09–1.18× body, so a real invented header can sit
 * just under 1.2. 1.15 still sits safely above the pinned ≈1.1× bold-title FP
 * (`sections.test.ts`), so no role-stranding regression — verified against the
 * full corpus snapshot.
 *
 * Font distinction is the PRIMARY visual signal here, but not the only one: a
 * font-metadata-independent text-pattern fallback (`isTextPatternHeader`, #163)
 * runs alongside it for renderers that strip or flatten font size below even
 * 1.15. The #112 note that bare body-size all-caps is dominated by NON-headers
 * (single-token acronyms/skill tokens "HTML"/"CSS"/"C++", inline values
 * "GPA: 3.5") still holds — so that fallback is tightly shaped (multi-word,
 * clean, ALL CAPS only; see `isTextPatternHeader`) to exclude exactly those
 * classes. Genuine all-caps *section* headers ("OBJECTIVE", "EDUCATION") are
 * still caught by the keyword/anchor path first, before either visual branch
 * runs.
 */
const VISUAL_HEADER_FONT_RATIO = 1.15;

/** Max characters for a line to still read as a header (not a prose line). */
const VISUAL_HEADER_MAX_CHARS = 40;
/** Max whitespace-separated words for a header (qualifier(s) + head noun). */
const VISUAL_HEADER_MAX_WORDS = 4;

/** Terminal sentence punctuation marks prose, not a heading. */
const TERMINAL_PUNCT_RE = /[.!?]$/;
/** Leading bullet glyph — a header-shaped bullet is content, not a heading. */
const VISUAL_BULLET_RE = /^\s*[•‣▪●◦⁃*\-–—]/;

/**
 * Character-weighted mode of `maxFontSize` across lines — the document body
 * baseline used by the visual-header test. Mirrors
 * `markdown-emit.ts::computeBodyFontSize`, but reads `PdfLine.maxFontSize`
 * (this module's line shape) rather than that module's `PdfLine.fontSize`;
 * weighting by character count keeps multi-line headers from dominating the
 * mode, so the long body paragraphs win. Returns 10pt for an empty document.
 */
function computeBodyBaseline(lines: PdfLine[]): number {
  if (lines.length === 0) return 10;
  const bins = new Map<number, number>();
  for (const line of lines) {
    const bin = Math.round(line.maxFontSize * 10) / 10;
    bins.set(bin, (bins.get(bin) ?? 0) + line.text.trim().length);
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

/**
 * Header *shape* test, independent of font: short (≤ `VISUAL_HEADER_MAX_CHARS`
 * chars, ≤ `VISUAL_HEADER_MAX_WORDS` words), not a bullet line, and not ending
 * in terminal sentence punctuation. This is the structural half of
 * `isVisualHeader`; the column-gated sidebar-header recovery (#117) reuses the
 * exact same predicate so the two paths can never drift on what counts as
 * header-shaped.
 */
function isHeaderShort(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > VISUAL_HEADER_MAX_CHARS) return false;
  if (VISUAL_BULLET_RE.test(t)) return false;
  if (TERMINAL_PUNCT_RE.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= VISUAL_HEADER_MAX_WORDS;
}

/**
 * Max whitespace-separated words for the font-metadata-independent text-pattern
 * header (#163). Slightly looser than the font path's `VISUAL_HEADER_MAX_WORDS`
 * (4) because invented multi-word labels ("VOLUNTEER EXPERIENCE & SERVICE")
 * run a touch longer than the qualifier+head-noun shape the anchor fallback
 * targets; capped at 6 so a short prose fragment can't slip through.
 */
const TEXT_PATTERN_HEADER_MAX_WORDS = 6;

/**
 * Characters that mark a line as content rather than a bare section label:
 * digits (dates / metrics / GPA), commas and pipes / mid-dots / dashes / slashes
 * (company–location, "ACME CORP | REMOTE", "SEP 2024 - JULY 2025"), and colons
 * (inline labels "GPA: 3.5"). A genuine invented header ("VOLUNTEER WORK",
 * "ADDITIONAL INFORMATION") carries none of these.
 */
const TEXT_PATTERN_DIRTY_RE = /[0-9,:·|—–/]/;

/**
 * Font-metadata-independent header test (#163). Some renderers (Skia/Chrome via
 * Google Docs → PDF) strip or flatten a section header's font-size lift so far
 * it doesn't clear even the lowered `VISUAL_HEADER_FONT_RATIO` (1.15). This
 * detects a header purely from text *shape* — independent of font size: a short
 * (≤ `VISUAL_HEADER_MAX_CHARS` chars, 2–`TEXT_PATTERN_HEADER_MAX_WORDS` words),
 * non-bullet, non-terminal-punctuation, ALL-CAPS line carrying none of the
 * `TEXT_PATTERN_DIRTY_RE` content markers.
 *
 * ALL CAPS *only* — deliberately NOT Title Case. The #112 corpus pass showed
 * Title-Case shape is dominated on the regex path by NON-header content a
 * boundary must never split on: job titles ("Sr Software Engineer", "Staff
 * Software Engineer"), company names ("Globex Corporation", "Acme Corp"), and
 * institutions ("Springfield State University") — all Title Case, all rendered
 * at or barely above body size, so neither a font-ratio floor nor a column gate
 * separates them from a real flattened header (the coursework reproducers sit
 * mid-band among them). Promoting any of them opens an `other` sink that strands
 * the role/degree beneath it. ALL CAPS multi-word lines, by contrast, are
 * reliably section labels in this corpus — the only all-caps clean ≥2-word
 * non-keyword lines are institution names on the *markdown* path
 * ("CORNELL UNIVERSITY"), which never reaches this splitter. So the title-cased
 * "Relevant Coursework" reproducer is fixed by its `education` keyword alias
 * (#163 sub-problem 1), and this path generalizes the boundary-termination to
 * any unknown ALL-CAPS header a metadata-stripping renderer flattens.
 *
 * The remaining gates kill the FP classes the bare-all-caps #112 experiment
 * tripped on: ≥ 2 words excludes single-token skill/acronym tokens ("HTML",
 * "CSS", "C++", "PHP"); `TEXT_PATTERN_DIRTY_RE` excludes date / location-comma /
 * separator / colon-bearing inline values ("GPA: 3.5").
 *
 * Like the font path it only runs after `matchSectionHeader` declines the line,
 * and (in `classifyLine`) only past the leading name/contact block — so a real
 * header it fires on opens the boundary-only `other` sink, terminating the prior
 * section. Verified zero-regression against the full corpus snapshot.
 */
function isTextPatternHeader(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > VISUAL_HEADER_MAX_CHARS) return false;
  if (VISUAL_BULLET_RE.test(t)) return false;
  if (TERMINAL_PUNCT_RE.test(t)) return false;
  if (TEXT_PATTERN_DIRTY_RE.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  // ≥ 2 words: a single token is a skill/acronym ("HTML", "GRADUATE"), not a
  // section header — bare single-token all-caps is the FP class #112 dropped.
  if (words.length < 2 || words.length > TEXT_PATTERN_HEADER_MAX_WORDS) {
    return false;
  }
  return isAllCapsHeader(t);
}

/** True when every letter-bearing char is uppercase (and at least one exists). */
function isAllCapsHeader(t: string): boolean {
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

/**
 * True when a line is *visually* a header. Two orthogonal signals, either of
 * which qualifies (after `matchSectionHeader` has already declined the line, so
 * a pass opens the boundary-only `other` sink that terminates the prior section):
 *   - font path: header-shaped (`isHeaderShort`) AND meaningfully larger than
 *     the body baseline (≥ `VISUAL_HEADER_FONT_RATIO`); or
 *   - text-pattern path (#163): font-metadata-independent — a short clean-shaped
 *     ALL-CAPS line (`isTextPatternHeader`), for renderers that flatten font
 *     size below the ratio gate.
 */
function isVisualHeader(line: PdfLine, bodyBaseline: number): boolean {
  if (isHeaderShort(line.text) &&
      line.maxFontSize >= bodyBaseline * VISUAL_HEADER_FONT_RATIO) {
    return true;
  }
  return isTextPatternHeader(line.text);
}

// Non-global clones of the contact REs for stateless boolean checks. The
// exported forms are `/g` and carry `lastIndex` across calls — calling
// `.test()` on them here would mutate state any future `.exec()`/`.test()`
// caller would inherit. Dropping the `g` flag makes `.test()` stateless; the
// pattern source stays single-sourced in regex.ts (we clone `.source`).
const EMAIL_TEST_RE = new RegExp(EMAIL_RE.source, EMAIL_RE.flags.replace("g", ""));
const PHONE_TEST_RE = new RegExp(PHONE_RE.source, PHONE_RE.flags.replace("g", ""));
const LINKEDIN_TEST_RE = new RegExp(
  LINKEDIN_RE.source,
  LINKEDIN_RE.flags.replace("g", ""),
);

/**
 * True when a line carries name/contact shape — an email, phone, or LinkedIn
 * URL. Used to keep a large contact line in the leading profile region from
 * being promoted to a section boundary. Uses non-global clones so no shared
 * regex `lastIndex` state is touched.
 */
function hasContactShape(text: string): boolean {
  return (
    EMAIL_TEST_RE.test(text) ||
    PHONE_TEST_RE.test(text) ||
    LINKEDIN_TEST_RE.test(text)
  );
}

// ── Section splitting ───────────────────────────────────────────────────────

/**
 * Scan the lines top-to-bottom, mark lines that open a section, and bucket
 * everything between headers. Content above the first header lands in the
 * synthetic `profile` section.
 *
 * A line opens a section boundary when ANY of:
 *   - keyword path: `matchSectionHeader` (L1 exact alias → L2 head-noun anchor)
 *     returns a canonical name → label = that section; or
 *   - visual path (L3 / #112): the line is visually a header (`isVisualHeader`)
 *     and is not a leading name/contact line → open an `other` boundary. The
 *     keyword path has already declined the line by this point, so the label is
 *     always `other` — the boundary-only sink that terminates the prior section
 *     without rendering (`regex.ts` keeps `other` out of the anchor path and out
 *     of every `findSection` lookup in `openresume.ts`); or
 *   - column-gated sidebar recovery (#117): a body-size, header-shaped line in
 *     the SECONDARY column of a detected two-column layout (`columnBoundaries`)
 *     whose trailing token is a fallback-enabled section anchor → label = that
 *     section. This recovers a real header that a two-column flatten glued a
 *     sidebar bar-value onto ("20% Projects"). The column signal stands in for
 *     the prose guards the unguarded `matchSectionAnchorToken` lookup drops, so
 *     it never fires on main-column prose ("5 Years Experience") or single-
 *     column docs.
 *
 * Name/contact disambiguation: the leading profile region opens with a cluster
 * of large-font name / title / tagline lines (a résumé header), then the
 * contact line(s). A genuine invented-label heading always comes *after* that
 * cluster. So while still in the profile region, a visual header is suppressed
 * (kept in profile) until a contact-shaped line (email / phone / LinkedIn) has
 * been seen — that contact line marks the end of the name block. This is what
 * stops the largest-font line at the top (the name), and any title/tagline
 * stacked under it, from becoming a section header and shattering the parse,
 * while still letting a font-distinct invented header below the contact block
 * open a boundary. Once any section has opened, the disambiguation no longer
 * applies (a visual header is then unconditionally a real boundary).
 *
 * `columnBoundaries` is the per-page split-x map from `detectColumnBoundaries`
 * (present only for detected two-column pages; undefined/empty otherwise). It
 * feeds the sidebar-header recovery branch in `classifyLine` (#117): a glued
 * sidebar artifact like `"20% Projects"` in the secondary column recovers its
 * real section name. For single-column docs the map is absent and that branch
 * never fires — output stays byte-identical to the pre-#117 behavior.
 */
export function splitIntoSections(
  lines: PdfLine[],
  columnBoundaries?: Map<number, number>,
): PdfSection[] {
  const sections: PdfSection[] = [{ name: "profile", lines: [] }];
  const bodyBaseline = computeBodyBaseline(lines);
  // True until the first non-profile section (keyword or visual) opens.
  let openedRealSection = false;
  // True once the leading name/title block has ended — signalled by the first
  // contact-shaped line inside the profile region.
  let seenContactInProfile = false;

  for (const line of lines) {
    // Per-line column split-x (undefined for single-column pages / docs).
    const columnSplitX = columnBoundaries?.get(line.page);
    const action = classifyLine(
      line,
      bodyBaseline,
      openedRealSection,
      seenContactInProfile,
      columnSplitX,
    );
    if (action.kind === "open") {
      sections.push({ name: action.name, lines: [] });
      openedRealSection = true;
      continue;
    }
    if (action.marksContactEnd) seenContactInProfile = true;
    sections[sections.length - 1].lines.push(line);
  }

  return sections;
}

/** What `classifyLine` decided to do with one line. */
type LineAction =
  | { kind: "open"; name: SectionName }
  | { kind: "append"; marksContactEnd: boolean };

/**
 * Decide whether a single line opens a section boundary or appends to the
 * current section — the per-line core of `splitIntoSections`, extracted as a
 * pure function of the line plus the two carry-forward state flags so the
 * splitter loop stays flat. `marksContactEnd` reports back that an appended
 * line is the contact line that ends the leading name block (the caller flips
 * `seenContactInProfile`).
 */
function classifyLine(
  line: PdfLine,
  bodyBaseline: number,
  openedRealSection: boolean,
  seenContactInProfile: boolean,
  columnSplitX: number | undefined,
): LineAction {
  const header = matchSectionHeader(line.text);
  if (header) return { kind: "open", name: header };

  const contactShaped = hasContactShape(line.text);

  if (isVisualHeader(line, bodyBaseline)) {
    // Inside the leading name/title block (no contact line seen yet, no section
    // open) — a font-distinct line here is the name or a title/tagline, never a
    // section header. Keep it in the profile; the contact line ends the block.
    if (!openedRealSection && !seenContactInProfile) {
      return { kind: "append", marksContactEnd: contactShaped };
    }
    // Past the name block (contact seen, or a real section already opened): a
    // visual header with no keyword match opens a boundary-only `other`.
    return { kind: "open", name: "other" };
  }

  // Two-column sidebar artifact: a flatten can glue a sidebar bar-value onto a
  // real header in the secondary column ("20% Projects"). The line is body-size
  // (no visual signal, so the branch above did not fire) and a single glued run
  // (no x-gap), so the only signal that separates it from main-column prose like
  // "5 Years Experience" is that it sits in the secondary column of a detected
  // two-column layout. Gate the unguarded trailing-anchor lookup on that column
  // signal + a header-short shape. Skipped entirely for single-column docs
  // (columnSplitX undefined) and main-column lines (line.x < split).
  if (
    columnSplitX !== undefined &&
    line.x >= columnSplitX &&
    isHeaderShort(line.text)
  ) {
    const recovered = matchSectionAnchorToken(line.text);
    if (recovered) return { kind: "open", name: recovered };
  }

  return { kind: "append", marksContactEnd: !openedRealSection && contactShaped };
}

/**
 * Helper: look up a section by name. Returns undefined if absent.
 *
 * A section header can legitimately repeat — most often EXPERIENCE, which
 * carries a "E XPERIENCE" continuation header at the top of page 2 on
 * multi-page two-column résumés. Both section splitters open a fresh section
 * each time a header matches (see `splitIntoSections` /
 * `splitIntoSectionsWithMarkdown`), so a repeated header yields two sections of
 * the same name. We merge their lines in document order here so the caller sees
 * the whole section; returning only the first occurrence (the old behavior)
 * silently dropped every role after the continuation header, stranding those
 * bullets in the unmatched "Other" group downstream.
 */
export function findSection(
  sections: PdfSection[],
  name: SectionName | "profile",
): PdfSection | undefined {
  const matches = sections.filter((s) => s.name === name);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return { name, lines: matches.flatMap((s) => s.lines) };
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

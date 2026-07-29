// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Group positional PDF items into `PdfLine`s — column banding, embedded
 * multi-column grid reordering, same-baseline clustering, letter-spacing
 * de-tracking, and item-to-text merging. Split out of `sections.ts` (#650):
 * `pdf-extract.ts` (Tier 0, eagerly reachable from `/`) and `markdown-emit.ts`
 * only ever needed this line-assembly layer, never the header-classification
 * logic (`splitIntoSections` and friends) that used to share the module —
 * so importing it pulled that ~2000-line body into the entry chunk too.
 * `LINE_Y_EPS` and `mergeItemText` are re-exported for `sections.ts`, which
 * still needs both past its own section-splitting logic.
 */

import type { PdfTextItem } from "./types.ts";
import { isLoneDateRange } from "./line-primitives.ts";
import type { PdfLine } from "./line-model.ts";

/** Items within this vertical distance (PDF points) are treated as same line. */
export const LINE_Y_EPS = 3.5;

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
    bands.push(...bandsForPage(byPage.get(page)!, boundaries.get(page)));
  }
  return bands;
}

/**
 * One page's bands: a single band when the page carries no split, else the whole
 * left column followed by the whole right one. Extracted from
 * {@link orderItemsByColumn} so that function reads as "page-major, ascending"
 * and this one owns the only rule that varies per page.
 */
function bandsForPage(
  pageItems: PdfTextItem[],
  split: number | undefined,
): PdfTextItem[][] {
  if (split === undefined) return [pageItems];
  const left: PdfTextItem[] = [];
  const right: PdfTextItem[] = [];
  for (const it of pageItems) {
    if (it.x < split) left.push(it);
    else right.push(it);
  }
  // Left band before right band; skip empty bands so a near-empty side
  // doesn't emit a spurious blank grouping pass.
  return [left, right].filter((band) => band.length > 0);
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

/**
 * Column-sized horizontal-gap cut indices within an x-sorted, same-y run — the
 * shared chokepoint for the line splitter (`flush`) and the embedded-column
 * detector (`rowIsMultiColumn`). A cut at index `i` marks items `[i..]` as
 * starting a new column past a `> COLUMN_GAP_THRESHOLD` gap.
 *
 * #425 flush-right-date exemption: when the FINAL segment (after the last cut)
 * is nothing but a lone date range, that trailing cut is dropped, so a role /
 * degree date the exporter draws flush-right stays merged into its org text
 * rather than peeling into its own column/line. Applying the exemption HERE —
 * not only in `flush` — is what neutralizes the ≥2-adjacent-row case: without it,
 * two consecutive `Org …(wide gap) Date` rows read as a 2-row embedded grid and
 * `reorderEmbeddedColumns` tears every date off its org into a trailing
 * column-major band (the #298 title↔company / right-edge-date-band regression).
 * A genuine coursework grid's trailing column is NOT a date range, so its cut
 * survives and the grid still reorders column-major.
 */
function columnGapCuts(sorted: PdfTextItem[]): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const gap = sorted[i].x - (prev.x + prev.width);
    if (gap > COLUMN_GAP_THRESHOLD) cuts.push(i);
  }
  if (
    cuts.length > 0 &&
    isLoneDateRange(mergeItemText(sorted.slice(cuts[cuts.length - 1])))
  ) {
    cuts.pop();
  }
  return cuts;
}

/** A row is "multi-column" when its x-sorted items carry a column-sized
 *  horizontal gap (the same `COLUMN_GAP_THRESHOLD` the line splitter uses),
 *  after the #425 flush-right-date exemption — so a lone flush-right date rail is
 *  NOT counted as a grid column (see `columnGapCuts`). */
function rowIsMultiColumn(row: PdfTextItem[]): boolean {
  if (row.length < 2) return false;
  const sorted = [...row].sort((a, b) => a.x - b.x);
  return columnGapCuts(sorted).length > 0;
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
  const lines = bands.flatMap(groupLinesSingle);
  assignGapAbove(lines);
  return lines;
}

/**
 * Fill each line's `gapAbove` from the line above it in final document order
 * (#216). The previous line must share a page — a cross-page transition leaves
 * `gapAbove` at its `0` default, so a page break never registers as a header
 * gap. Band ordering (`orderItemsByColumn`) already emits the left column fully
 * before the right on a split page, so within a band the y-deltas are
 * monotonic; at a band boundary on the SAME page the y jumps backward (right
 * column starts back at the top), which yields a negative delta — clamped to
 * `0`, again no false header gap. So the signal is only ever positive within a
 * single reading column, exactly where paragraph spacing is meaningful.
 */
function assignGapAbove(lines: PdfLine[]): void {
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (cur.page !== prev.page) continue;
    const gap = cur.y - prev.y;
    if (gap > 0) cur.gapAbove = gap;
  }
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
      // Filled in document order by `assignGapAbove` after all bands are
      // flattened; a per-band builder has no view of the line above it.
      gapAbove: 0,
    };
  };

  const flush = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    // Split the same-y cluster at column-sized horizontal gaps so two-column
    // layouts that share a baseline don't get merged into one PdfLine (#9), with
    // the #425 flush-right-date exemption applied by `columnGapCuts` so an
    // exporter-drawn flush-right date stays merged onto its org line.
    const cuts = columnGapCuts(current);
    let runStart = 0;
    for (const cut of cuts) {
      lines.push(buildLine(current.slice(runStart, cut)));
      runStart = cut;
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
 * Minimum single-letter run length that reads as letter-spacing (tracked-out
 * type) rather than genuine single-char tokens. Four keeps initials ("J R R"),
 * roman numerals ("I V X"), and short spaced acronyms out of the collapse.
 */
const LETTER_SPACING_MIN_RUN = 4;

/**
 * Regex for a maximal run of ≥`LETTER_SPACING_MIN_RUN` single letters each
 * separated by exactly one space (`J O R D A N`). `\p{L}` (Unicode letter, `u`
 * flag) so accented names de-track too (`A N D R É S` → `ANDRÉS`), not just
 * ASCII. Anchored on both sides by a non-letter (or string edge) so a trailing
 * multi-char word isn't swallowed ("J O R D A N Reyes" → only "J O R D A N"
 * collapses). Requiring exactly one space per pair means a wider (≥2-space)
 * inter-word gap ends the run, preserving that word boundary even inside one
 * item (`"J O R D A N  R E Y E S"` → `"JORDAN REYES"`).
 */
const LETTER_SPACED_RUN = new RegExp(
  `(?<!\\p{L})(?:\\p{L} ){${LETTER_SPACING_MIN_RUN - 1},}\\p{L}(?!\\p{L})`,
  "gu",
);

/**
 * Collapse letter-spaced (tracked-out) runs inside one pdfjs item string.
 * A heading rendered with wide `letter-spacing` reaches us as glyphs joined by
 * spaces *within a single item* (`"J O R D A N"`), while genuine word breaks
 * arrive as separate items — so collapsing per item de-tracks each word yet
 * preserves the real word boundary between items (#330). Every downstream
 * extractor (name, contact, sections) then sees `"JORDAN"`, not `"J O R D A N"`.
 *
 * Scope: this recovers the word boundary when it surfaces as a separate item
 * (the observed pdfjs shape) or as a ≥2-space gap within an item. The one case
 * it cannot resolve is a whole multi-word heading emitted as a *single* item
 * with a *single*-space word gap — then intra- and inter-word gaps are
 * indistinguishable from the string alone and the words would weld. Not
 * observed for pdfjs on the #330 corpus; a gap-magnitude split would be needed.
 */
export function collapseLetterSpacing(str: string): string {
  return str.replace(LETTER_SPACED_RUN, (run) => run.replace(/ /g, ""));
}

/**
 * Concatenate items on a line, inserting a space when the horizontal gap
 * between runs is large enough to imply a word boundary. pdfjs emits each
 * glyph run as a separate item, so naively joining with spaces over-pads
 * and joining without spaces under-pads.
 */
export function mergeItemText(items: PdfTextItem[]): string {
  if (items.length === 0) return "";
  // De-track each item first (geometry left untouched — gap math below still
  // uses the original item widths). Collapsing per item keeps the word-boundary
  // items intact, so `"J O R D A N"` + `" "` + `"R E Y E S"` → `"JORDAN REYES"`.
  const strs = items.map((it) => collapseLetterSpacing(it.str));
  let out = strs[0];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const gap = cur.x - (prev.x + prev.width);
    const avgCharW = prev.width / Math.max(prev.str.length, 1);
    // Gap wider than ~half a character triggers an inserted space.
    // Also always insert a space if either side already has trailing/leading ws.
    const prevEndsWs = /\s$/.test(strs[i - 1]);
    const curStartsWs = /^\s/.test(strs[i]);
    const needSpace = !prevEndsWs && !curStartsWs && gap > avgCharW * 0.4;
    out += (needSpace ? " " : "") + strs[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

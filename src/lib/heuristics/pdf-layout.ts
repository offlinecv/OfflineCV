// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tier 0 — layout probes.
 *
 * Inputs: the `PdfTextItem[]` emitted by `pdf-extract.ts` plus `PdfPageInfo[]`.
 * Outputs: a `LayoutProbes` record plus the `triggers` array the confidence
 * scorer and escalation logic read.
 *
 * Pure function — no DOM, no pdfjs dependency. Trivially unit-testable on
 * synthetic inputs.
 */

import type {
  PdfPageInfo,
  PdfTextItem,
  LayoutProbes,
  LayoutTrigger,
  ExtractionFailureReason,
} from "./types.ts";

// ── Thresholds (tuneable) ───────────────────────────────────────────────────

const SCANNED_MIN_CHARS_PER_PAGE = 80;

/**
 * Maximum share of a page's text *rows* that may paint ink at the gutter strip
 * for it to count as a real inter-column corridor. This is the primary
 * single-column discriminator, measured by a width-aware vertical ink
 * projection (see `detectColumnBoundaries`). Across the labeled corpus the two
 * populations are cleanly separated with no overlap: genuine two-column layouts
 * leave a corridor painted by ≤2.4% of rows, while single-column docs — even
 * ones with a right-aligned date/label rail that mimics a second column — never
 * drop below 6.3% (their wide wrapped body text inks straight through the
 * would-be gutter). Set in the gap between those populations.
 */
const TWO_COLUMN_MAX_GUTTER_COVERAGE = 0.04;

/**
 * The gutter's center must fall inside this central band of the page
 * ([lo, hi] × width). Excludes the empty right margin of a single-column doc,
 * which is empty but is not *between* two columns.
 */
const TWO_COLUMN_BAND_LO = 0.2;
const TWO_COLUMN_BAND_HI = 0.8;

/** Minimum gutter width (as a fraction of page width) — guards against a
 *  degenerate one-strip "corridor" between two adjacent words. */
const TWO_COLUMN_MIN_GUTTER_RATIO = 0.01;

/**
 * Minimum inked text rows required on *each* side of the split. The single
 * guard the coverage test cannot supply on its own: it rejects the empty right
 * margin of a narrow single-column doc (zero rows right of the corridor) and
 * stray right-edge furniture like a footer page number (a row or two), neither
 * of which is a real column.
 */
const TWO_COLUMN_MIN_COLUMN_ROWS = 4;

/** Minimum item count on a page before its x-distribution is trustworthy. */
const TWO_COLUMN_MIN_ITEMS_PER_PAGE = 30;

/** Vertical ink-projection sampling resolution, in PDF points. */
const X_PROJECTION_STEP = 3;

/** Items within this vertical distance (PDF points) are treated as one row. */
const ROW_Y_EPS = 3.5;

// ── Probes ──────────────────────────────────────────────────────────────────

export function analyzeLayout(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
  extractionFailureReason?: ExtractionFailureReason,
): LayoutProbes {
  const isScanned = probeScanned(pages);
  // If scanned, two-column probe is meaningless (no positional signal).
  const isTwoColumn = isScanned
    ? false
    : detectColumnBoundaries(items, pages).size > 0;

  const triggers: LayoutTrigger[] = [];
  // `fonts_unmappable` and `scanned` both mean "no extractable text", so
  // both short-circuit the cascade. We label the trigger with the more
  // accurate reason when extraction told us why it came back empty
  //: true scan → `scanned`; text-PDF with un-decodable fonts
  // → `fonts_unmappable`. The dashboard branches its user-facing copy on
  // which one fired. `isScanned` stays true for both so the cascade's
  // short-circuit branch still triggers.
  if (isScanned) {
    triggers.push(
      extractionFailureReason === "fonts_unmappable"
        ? "fonts_unmappable"
        : "scanned",
    );
  }
  if (isTwoColumn) triggers.push("two_column");

  return { isScanned, isTwoColumn, triggers };
}

function probeScanned(pages: PdfPageInfo[]): boolean {
  if (pages.length === 0) return true;
  const avgChars =
    pages.reduce((s, p) => s + p.charCount, 0) / pages.length;
  // Character sparsity is the reliable scanned/no-extractable-text signal: an
  // image-only or fonts-unmappable page yields ~0 characters. Item count is NOT
  // an independent scanned signal — item granularity is a property of how the
  // producer laid out text, not of whether text exists. Our own reconstructed
  // "Download PDF" emits one text item per line, so a short-but-real résumé
  // (e.g. a compact single-role + single-degree doc) has only a handful of
  // items yet hundreds of real characters. Gating on `avgItems` there
  // false-positived as `scanned`, short-circuiting the cascade and zeroing an
  // otherwise fully parseable document (#296). A page with real characters is
  // real text regardless of how few items it split into.
  return avgChars < SCANNED_MIN_CHARS_PER_PAGE;
}

/**
 * Two-column detection, per page → split-x map (page number → column-channel x).
 *
 * We find the inter-column gutter with a width-aware vertical ink projection.
 * Items are grouped into text rows (by y); each row paints the x-strips its
 * items actually cover — `x` through `x + width`, not just the start. For each
 * x-strip we then count the share of rows that paint it. The gutter is the
 * widest run of central strips whose row-coverage stays at or below
 * `TWO_COLUMN_MAX_GUTTER_COVERAGE`; the split is its center. A page qualifies
 * when such a corridor exists in the central band and both sides carry at least
 * `TWO_COLUMN_MIN_COLUMN_ROWS` inked rows.
 *
 * Why ink projection rather than an x-start histogram (the earlier approach):
 * a histogram of where items *begin* is blind to how far they *extend*. A wide
 * wrapped bullet that starts at the left margin but runs nearly full width reads
 * as a single left-margin tick — so a single-column doc with a right-aligned
 * date/label rail (its body text inks straight across the would-be gutter) is
 * indistinguishable from a genuine narrow sidebar. Accounting for each item's
 * full horizontal extent is exactly what separates them: a real two-column
 * layout leaves a vertical corridor no row paints, while a date rail's "gutter"
 * is crossed by every wrapped body line. Across the labeled corpus this cleanly
 * separates the two populations (≤2.4% vs ≥6.3% gutter row-coverage) where the
 * x-start histogram's populations overlapped.
 *
 * Pages with fewer than `TWO_COLUMN_MIN_ITEMS_PER_PAGE` items are skipped (too
 * sparse to trust). A page contributes an entry only when it qualifies; an empty
 * map = single-column.
 */
export function detectColumnBoundaries(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
): Map<number, number> {
  const boundaries = new Map<number, number>();
  if (items.length === 0) return boundaries;

  const fallbackWidth = pages[0]?.width || 612; // US Letter default

  // Group items by page.
  const byPage = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    const pageItems = byPage.get(it.page);
    if (pageItems) pageItems.push(it);
    else byPage.set(it.page, [it]);
  }

  for (const [page, pageItems] of byPage) {
    if (pageItems.length < TWO_COLUMN_MIN_ITEMS_PER_PAGE) continue;
    const pageInfo = pages.find((p) => p.page === page);
    const pageWidth = pageInfo?.width || fallbackWidth;

    // Cluster items into text rows by y-proximity.
    const sorted = [...pageItems].sort((a, b) => a.y - b.y);
    const rows: PdfTextItem[][] = [];
    for (const it of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last[0].y - it.y) <= ROW_Y_EPS) last.push(it);
      else rows.push([it]);
    }
    if (rows.length < TWO_COLUMN_MIN_COLUMN_ROWS * 2) continue;

    // Vertical ink projection: for each x-strip, how many rows paint it
    // (counting each item's full horizontal extent, not just its start).
    const cols = Math.ceil(pageWidth / X_PROJECTION_STEP);
    const rowCoverage = new Float64Array(cols);
    for (const row of rows) {
      const painted = new Uint8Array(cols);
      for (const it of row) {
        const x0 = Math.max(0, Math.floor(it.x / X_PROJECTION_STEP));
        const x1 = Math.min(
          cols - 1,
          Math.floor((it.x + it.width) / X_PROJECTION_STEP),
        );
        for (let c = x0; c <= x1; c++) painted[c] = 1;
      }
      for (let c = 0; c < cols; c++) rowCoverage[c] += painted[c];
    }

    // Widest run of low-coverage strips inside the central band = the gutter.
    const lo = Math.floor((pageWidth * TWO_COLUMN_BAND_LO) / X_PROJECTION_STEP);
    const hi = Math.ceil((pageWidth * TWO_COLUMN_BAND_HI) / X_PROJECTION_STEP);
    let bestLen = 0;
    let bestCenter = -1;
    let run = 0;
    let runStart = 0;
    for (let c = lo; c <= hi && c < cols; c++) {
      if (rowCoverage[c] / rows.length <= TWO_COLUMN_MAX_GUTTER_COVERAGE) {
        if (run === 0) runStart = c;
        run++;
        if (run > bestLen) {
          bestLen = run;
          bestCenter = (runStart + c) / 2;
        }
      } else {
        run = 0;
      }
    }
    if (bestCenter < 0) continue;
    if (bestLen * X_PROJECTION_STEP < pageWidth * TWO_COLUMN_MIN_GUTTER_RATIO) {
      continue;
    }
    const split = bestCenter * X_PROJECTION_STEP;

    // Guard: a real column on each side (rejects empty right margin / footer).
    let leftRows = 0;
    let rightRows = 0;
    for (const row of rows) {
      if (row.some((it) => it.x < split)) leftRows++;
      if (row.some((it) => it.x >= split)) rightRows++;
    }
    if (
      leftRows < TWO_COLUMN_MIN_COLUMN_ROWS ||
      rightRows < TWO_COLUMN_MIN_COLUMN_ROWS
    ) {
      continue;
    }

    boundaries.set(page, split);
  }

  return boundaries;
}


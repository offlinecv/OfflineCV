// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
const SCANNED_MIN_ITEMS_PER_PAGE = 15;

/**
 * Minimum x-distance between the two dominant x-start peaks (as a fraction of
 * page width) for a layout to count as two-column. Single-column documents
 * have their two tallest x-start bins adjacent (left margin + first indent),
 * so this gap stays small and rejects them.
 */
export const TWO_COLUMN_MIN_GAP_RATIO = 0.25;

/**
 * Minimum share of a page's items that must fall strictly on each side of the
 * candidate split for it to count as a real second column. This is the primary
 * single-column discriminator: a genuine two-column resume splits its item
 * mass roughly evenly (~0.42–0.44 each side in the corpus), whereas a
 * single-column doc with a stray right-aligned date/label column straddling the
 * midpoint sits well below this (≤0.39 observed). Tuned to fall in the clean
 * gap between those two populations.
 */
const TWO_COLUMN_MIN_SIDE_SHARE = 0.4;

/** Minimum item count on a page before its x-distribution is trustworthy. */
const TWO_COLUMN_MIN_ITEMS_PER_PAGE = 30;

/** x-coord bin width in PDF points. */
export const X_BIN = 18;

// ── Probes ──────────────────────────────────────────────────────────────────

export function analyzeLayout(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
  extractionFailureReason?: ExtractionFailureReason,
): LayoutProbes {
  const isScanned = probeScanned(items, pages);
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

function probeScanned(items: PdfTextItem[], pages: PdfPageInfo[]): boolean {
  if (pages.length === 0) return true;
  const avgChars =
    pages.reduce((s, p) => s + p.charCount, 0) / pages.length;
  const avgItems = items.length / pages.length;
  return (
    avgChars < SCANNED_MIN_CHARS_PER_PAGE ||
    avgItems < SCANNED_MIN_ITEMS_PER_PAGE
  );
}

/**
 * Two-column detection, per page → split-x map (page number → column-channel x).
 *
 * Per page we bin item x-starts into `X_BIN`-wide bins, then locate the layout's
 * two dominant x-start peaks (the two tallest bins): the left margin and the
 * right column's left margin. A page qualifies as two-column when, taking the
 * lower-x peak as `leftPeak` and the higher-x peak as `rightPeak`:
 *   (a) the peak separation `(rightPeak − leftPeak) * X_BIN` is at least
 *       `TWO_COLUMN_MIN_GAP_RATIO * pageWidth`, and
 *   (b) at least `TWO_COLUMN_MIN_SIDE_SHARE` of the page's items fall strictly
 *       on each side of the split.
 *
 * Why two-tallest-peaks rather than the widest empty x-channel: the empty
 * channel is brittle. Left-column lines wrap and spill a few tokens into the
 * gutter (e.g. a wrapped word starting mid-channel), which fragments the "empty"
 * channel into two narrow gaps and hides the real boundary — and the genuinely
 * *widest* gap can then cut through the left column's wrapped tail rather than
 * between the columns. The column *margins*, by contrast, are tall, stable
 * spikes (many lines share each column's left edge), so the two tallest bins
 * reliably mark the two columns even when the gutter is noisy. The side-share
 * floor (b) is the single-column guard: a real two-column layout balances its
 * mass ~evenly across the split, while a single-column doc with a stray
 * right-aligned date/label column does not.
 *
 * The split x is placed at the right column's left edge so wrapped left-column
 * tokens (which sit in the gutter, left of the right margin) bin LEFT: it is the
 * midpoint between the right edge of the nearest occupied bin strictly left of
 * `rightPeak` and the left edge of the `rightPeak` bin. Pages with fewer than
 * `TWO_COLUMN_MIN_ITEMS_PER_PAGE` items are skipped (too sparse to trust). A
 * page contributes an entry only when it qualifies; an empty map = single-column.
 */
export function detectColumnBoundaries(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
): Map<number, number> {
  const boundaries = new Map<number, number>();
  if (items.length === 0) return boundaries;

  const fallbackWidth = pages[0]?.width || 612; // US Letter default

  // Group item x-starts by page.
  const byPage = new Map<number, number[]>();
  for (const it of items) {
    const xs = byPage.get(it.page);
    if (xs) xs.push(it.x);
    else byPage.set(it.page, [it.x]);
  }

  for (const [page, xs] of byPage) {
    if (xs.length < TWO_COLUMN_MIN_ITEMS_PER_PAGE) continue;
    const pageInfo = pages.find((p) => p.page === page);
    const pageWidth = pageInfo?.width || fallbackWidth;

    // Occupied-bin histogram (bin index → item count).
    const bins = new Map<number, number>();
    for (const x of xs) {
      const bin = Math.floor(x / X_BIN);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    const occupied = [...bins.keys()].sort((a, b) => a - b);
    if (occupied.length < 2) continue;

    // Two tallest bins = the two column left-margins. Order them by x.
    const byCount = [...bins.entries()].sort((a, b) => b[1] - a[1]);
    const peakA = byCount[0][0];
    const peakB = byCount[1][0];
    const leftPeak = Math.min(peakA, peakB);
    const rightPeak = Math.max(peakA, peakB);

    // (a) Peak separation wide enough to be two columns, not adjacent indents.
    if ((rightPeak - leftPeak) * X_BIN < pageWidth * TWO_COLUMN_MIN_GAP_RATIO) {
      continue;
    }

    // Split at the right column's left edge: midpoint between the nearest
    // occupied bin strictly left of rightPeak and rightPeak's left edge.
    let nearestLeft = -1;
    for (const b of occupied) {
      if (b < rightPeak) nearestLeft = b;
      else break;
    }
    if (nearestLeft < 0) continue;
    const split = ((nearestLeft + 1) * X_BIN + rightPeak * X_BIN) / 2;

    // (b) Item mass balanced across the split (the single-column guard).
    let leftMass = 0;
    for (const x of xs) if (x < split) leftMass++;
    const rightMass = xs.length - leftMass;
    const minSideMass = xs.length * TWO_COLUMN_MIN_SIDE_SHARE;
    if (leftMass < minSideMass || rightMass < minSideMass) continue;

    boundaries.set(page, split);
  }

  return boundaries;
}


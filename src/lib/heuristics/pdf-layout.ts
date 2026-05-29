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

/** Minimum x-coord gap between the two modes to call a layout two-column. */
const TWO_COLUMN_MIN_GAP_RATIO = 0.25;

/** Minimum share of items that must cluster into two peaks. */
const TWO_COLUMN_MIN_DENSITY = 0.6;

/** x-coord bin width in PDF points. */
const X_BIN = 18;

// ── Probes ──────────────────────────────────────────────────────────────────

export function analyzeLayout(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
  extractionFailureReason?: ExtractionFailureReason,
): LayoutProbes {
  const isScanned = probeScanned(items, pages);
  // If scanned, two-column probe is meaningless (no positional signal).
  const isTwoColumn = isScanned ? false : probeTwoColumn(items, pages);

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
 * Two-column detection: bin x-coord starts, look for two dominant peaks
 * separated by a gap wider than TWO_COLUMN_MIN_GAP_RATIO * pageWidth, and
 * require that the two peaks together account for TWO_COLUMN_MIN_DENSITY
 * of all items.
 *
 * Single-column resumes cluster into one dominant peak at the left margin.
 */
function probeTwoColumn(
  items: PdfTextItem[],
  pages: PdfPageInfo[],
): boolean {
  if (items.length < 40 || pages.length === 0) return false;
  const pageWidth = pages[0].width || 612; // US Letter default

  // Histogram of leftmost x-coord (item starts) in PDF points.
  const bins = new Map<number, number>();
  for (const it of items) {
    const bin = Math.floor(it.x / X_BIN);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return false;

  const [peak1, peak2] = sorted;
  const density = (peak1[1] + peak2[1]) / items.length;
  if (density < TWO_COLUMN_MIN_DENSITY) return false;

  const xGap = Math.abs(peak1[0] - peak2[0]) * X_BIN;
  return xGap >= pageWidth * TWO_COLUMN_MIN_GAP_RATIO;
}


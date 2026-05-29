// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Factories for synthetic `PdfTextItem` / `PdfPageInfo` inputs used by the
 * Tier 1 parser and confidence-scorer tests. Lets tests describe resumes in
 * line-by-line prose without caring about PDF coordinate arithmetic.
 */

import type { PdfPageInfo, PdfTextItem } from "../types.ts";

export interface LineSpec {
  text: string;
  /** 0-indexed line number; y is derived from it. */
  lineIndex: number;
  /** Starting x in points (default 72). */
  x?: number;
  /** Font size in points (default 11). Larger = name / section header. */
  fontSize?: number;
  /** 1-indexed page number (default 1). */
  page?: number;
}

const LINE_HEIGHT = 14;
const TOP_MARGIN = 72;

/** Build a single `PdfTextItem` from a line spec (one text run per line). */
export function mkItem(spec: LineSpec): PdfTextItem {
  const fontSize = spec.fontSize ?? 11;
  const x = spec.x ?? 72;
  const y = TOP_MARGIN + spec.lineIndex * LINE_HEIGHT;
  return {
    page: spec.page ?? 1,
    str: spec.text,
    x,
    y,
    width: spec.text.length * (fontSize * 0.5),
    height: fontSize,
    fontSize,
    fontName: `font-${fontSize}`,
    hasEOL: true,
  };
}

/** Build items from a line-by-line array. Convenience for readable tests. */
export function mkItems(
  specs: Array<Omit<LineSpec, "lineIndex"> & { lineIndex?: number }>,
): PdfTextItem[] {
  return specs.map((s, i) => mkItem({ ...s, lineIndex: s.lineIndex ?? i }));
}

export function mkPage(
  page: number,
  items: PdfTextItem[],
  width = 612,
  height = 792,
): PdfPageInfo {
  const pageItems = items.filter((i) => i.page === page);
  return {
    page,
    width,
    height,
    charCount: pageItems.reduce((n, it) => n + it.str.length, 0),
  };
}

/** Build default single-page info based on extracted items. */
export function mkDefaultPages(items: PdfTextItem[]): PdfPageInfo[] {
  const pageNums = new Set(items.map((i) => i.page));
  return [...pageNums].sort().map((n) => mkPage(n, items));
}

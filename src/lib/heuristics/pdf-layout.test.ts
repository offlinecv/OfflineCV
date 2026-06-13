// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { analyzeLayout, detectColumnBoundaries } from "./pdf-layout.ts";
import type { PdfPageInfo, PdfTextItem } from "./types.ts";

function mkItemAt(page: number, x: number, y: number, str = "x"): PdfTextItem {
  return {
    page,
    str,
    x,
    y,
    width: str.length * 6,
    height: 10,
    fontSize: 11,
    fontName: "f",
    hasEOL: false,
  };
}

/**
 * A single text line with an explicit horizontal extent (`x` → `x + width`).
 * The two-column detector projects ink across each item's full width, so tests
 * must model how far a line reaches, not just where it starts.
 */
function mkLine(
  page: number,
  x: number,
  y: number,
  width: number,
): PdfTextItem {
  return {
    page,
    str: "line",
    x,
    y,
    width,
    height: 10,
    fontSize: 11,
    fontName: "f",
    hasEOL: false,
  };
}

const singlePage: PdfPageInfo[] = [
  { page: 1, width: 612, height: 792, charCount: 1500 },
];

describe("analyzeLayout", () => {
  it("flags scanned PDFs when item count is near zero", () => {
    const items = [mkItemAt(1, 100, 100, "logo")];
    const pages: PdfPageInfo[] = [
      { page: 1, width: 612, height: 792, charCount: 4 },
    ];
    const probes = analyzeLayout(items, pages);
    expect(probes.isScanned).toBe(true);
    expect(probes.triggers).toContain("scanned");
  });

  it("does not flag scanned for a text-dense PDF", () => {
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 100; i++) items.push(mkItemAt(1, 72, 100 + i, `word${i}`));
    const probes = analyzeLayout(items, singlePage);
    expect(probes.isScanned).toBe(false);
  });

  it("detects two-column layout by the empty inter-column corridor", () => {
    const items: PdfTextItem[] = [];
    // Left column (x 72→252) and right column (x 360→520) leave an empty
    // vertical corridor at x≈252–360 that no row paints through. Rows are
    // y-offset between columns so the columns flow independently.
    for (let i = 0; i < 20; i++) items.push(mkLine(1, 72, 100 + i * 14, 180));
    for (let i = 0; i < 20; i++) items.push(mkLine(1, 360, 107 + i * 14, 160));
    const probes = analyzeLayout(items, singlePage);
    expect(probes.isTwoColumn).toBe(true);
    expect(probes.triggers).toContain("two_column");
  });

  it("does NOT flag two-column on a normal single-column resume", () => {
    const items: PdfTextItem[] = [];
    // Full-width body lines (x 72→532) ink straight across the central band,
    // so there is no empty corridor.
    for (let i = 0; i < 40; i++) items.push(mkLine(1, 72, 100 + i * 14, 460));
    const probes = analyzeLayout(items, singlePage);
    expect(probes.isTwoColumn).toBe(false);
  });

  it("does NOT flag two-column on a single-column resume with a right-aligned date rail", () => {
    const items: PdfTextItem[] = [];
    // Wide wrapped body (x 72→512) plus a right-aligned date (x 520→560) on
    // every fourth row. The body inks through the would-be gutter, so the
    // date rail never reads as a real second column.
    for (let i = 0; i < 40; i++) {
      items.push(mkLine(1, 72, 100 + i * 14, 440));
      if (i % 4 === 0) items.push(mkLine(1, 520, 100 + i * 14, 40));
    }
    const probes = analyzeLayout(items, singlePage);
    expect(probes.isTwoColumn).toBe(false);
  });

  it("emits fonts_unmappable when extraction failure reason is provided", () => {
    // Framer-style PDF: zero text items but a real page with viewport. The
    // extractor flags the case via extractionFailureReason; analyzeLayout
    // re-labels the trigger from "scanned" to "fonts_unmappable" so the UI
    // can show accurate copy.
    const items: PdfTextItem[] = [];
    const pages: PdfPageInfo[] = [
      { page: 1, width: 804, height: 1040, charCount: 0 },
    ];
    const probes = analyzeLayout(items, pages, "fonts_unmappable");
    expect(probes.isScanned).toBe(true);
    expect(probes.triggers).toContain("fonts_unmappable");
    expect(probes.triggers).not.toContain("scanned");
  });

  it("still emits scanned (not fonts_unmappable) when extraction reason is undefined", () => {
    const items: PdfTextItem[] = [];
    const pages: PdfPageInfo[] = [
      { page: 1, width: 612, height: 792, charCount: 0 },
    ];
    const probes = analyzeLayout(items, pages);
    expect(probes.isScanned).toBe(true);
    expect(probes.triggers).toContain("scanned");
    expect(probes.triggers).not.toContain("fonts_unmappable");
  });
});

describe("detectColumnBoundaries", () => {
  it("returns a split inside the corridor between the two columns", () => {
    const items: PdfTextItem[] = [];
    // Left column ends at x=252, right column starts at x=360.
    for (let i = 0; i < 20; i++) items.push(mkLine(1, 72, 100 + i * 14, 180));
    for (let i = 0; i < 20; i++) items.push(mkLine(1, 360, 107 + i * 14, 160));

    const boundaries = detectColumnBoundaries(items, singlePage);
    expect(boundaries.size).toBe(1);
    const split = boundaries.get(1)!;
    // Split must sit strictly inside the empty corridor so every left item
    // bins left and every right item bins right.
    expect(split).toBeGreaterThan(252);
    expect(split).toBeLessThan(360);
  });

  it("returns no boundary for an indented single-column page", () => {
    // Full-width body plus deeper-indented bullets: ink still spans the
    // central band on every row, so there is no corridor.
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 30; i++) items.push(mkLine(1, 72, 100 + i * 14, 460));
    for (let i = 0; i < 15; i++) items.push(mkLine(1, 96, 110 + i * 14, 420));

    expect(detectColumnBoundaries(items, singlePage).size).toBe(0);
  });

  it("returns no boundary for a single-column page with a right-aligned date column", () => {
    // Wide body inks through the central band; the far-right dates sit beyond
    // it, so no empty corridor forms between body and dates.
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 40; i++) {
      items.push(mkLine(1, 72, 100 + i * 14, 440));
      if (i % 5 === 0) items.push(mkLine(1, 520, 100 + i * 14, 40));
    }

    expect(detectColumnBoundaries(items, singlePage).size).toBe(0);
  });

  it("returns an empty map for empty input", () => {
    expect(detectColumnBoundaries([], singlePage).size).toBe(0);
  });
});

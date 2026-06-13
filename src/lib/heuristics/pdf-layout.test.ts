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

  it("detects two-column layout by x-histogram bimodality", () => {
    const items: PdfTextItem[] = [];
    // Left column
    for (let i = 0; i < 60; i++) items.push(mkItemAt(1, 72, 100 + i * 3, "left"));
    // Right column — far enough away to exceed TWO_COLUMN_MIN_GAP_RATIO * 612
    for (let i = 0; i < 60; i++) items.push(mkItemAt(1, 380, 100 + i * 3, "right"));
    const probes = analyzeLayout(items, singlePage);
    expect(probes.isTwoColumn).toBe(true);
    expect(probes.triggers).toContain("two_column");
  });

  it("does NOT flag two-column on a normal single-column resume", () => {
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 60; i++) items.push(mkItemAt(1, 72, 100 + i * 3, "content"));
    for (let i = 0; i < 10; i++) items.push(mkItemAt(1, 80, 100 + i * 3, "indent"));
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
  it("returns a split between the two columns of a two-column page", () => {
    const items: PdfTextItem[] = [];
    // Left column at x=72, right column at x=380, ~even mass on each side.
    for (let i = 0; i < 40; i++) items.push(mkItemAt(1, 72, 100 + i * 3, "left"));
    for (let i = 0; i < 40; i++) items.push(mkItemAt(1, 380, 100 + i * 3, "right"));

    const boundaries = detectColumnBoundaries(items, singlePage);
    expect(boundaries.size).toBe(1);
    const split = boundaries.get(1)!;
    // Split must sit strictly between the two columns so every left item bins
    // left and every right item bins right.
    expect(split).toBeGreaterThan(72);
    expect(split).toBeLessThanOrEqual(380);
  });

  it("returns no boundary for an indented single-column page", () => {
    // Margin text at x=72 plus indented bullets at x=90: the two tallest bins
    // are adjacent, so the peak separation never reaches the column gap.
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 40; i++) items.push(mkItemAt(1, 72, 100 + i * 3, "body"));
    for (let i = 0; i < 15; i++) items.push(mkItemAt(1, 90, 100 + i * 3, "bullet"));

    expect(detectColumnBoundaries(items, singlePage).size).toBe(0);
  });

  it("returns no boundary for a single-column page with a right-aligned date column", () => {
    // A handful of right-aligned dates far to the right do not balance the
    // page's mass, so the side-share guard rejects them as a second column.
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 40; i++) items.push(mkItemAt(1, 72, 100 + i * 3, "body"));
    for (let i = 0; i < 5; i++) items.push(mkItemAt(1, 500, 100 + i * 30, "2021"));

    expect(detectColumnBoundaries(items, singlePage).size).toBe(0);
  });

  it("returns an empty map for empty input", () => {
    expect(detectColumnBoundaries([], singlePage).size).toBe(0);
  });
});

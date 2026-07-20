// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Column-aware line grouping (#60).
 *
 * Verifies that when a per-page column split-x is supplied, `groupIntoLines`
 * (via `orderItemsByColumn`) reads a two-column page in column order — every
 * left-column line before every right-column line — instead of interleaving
 * them by a global (y, x) sort, and that the no-boundary path is unchanged.
 */

import { groupIntoLines, orderItemsByColumn } from "./sections.ts";
import type { PdfTextItem } from "./types.ts";

function mkItem(x: number, y: number, str: string, page = 1): PdfTextItem {
  return {
    page,
    str,
    x,
    y,
    width: str.length * 6,
    height: 11,
    fontSize: 11,
    fontName: "font-11",
    hasEOL: true,
  };
}

// A two-column page: left column (x=72) and right column (x=380) whose rows
// share baselines, so a global (y, x) sort would interleave them L,R,L,R…
const LEFT_X = 72;
const RIGHT_X = 380;
const twoColumnItems: PdfTextItem[] = [
  mkItem(LEFT_X, 100, "left-1"),
  mkItem(RIGHT_X, 100, "right-1"),
  mkItem(LEFT_X, 120, "left-2"),
  mkItem(RIGHT_X, 120, "right-2"),
  mkItem(LEFT_X, 140, "left-3"),
  mkItem(RIGHT_X, 140, "right-3"),
];
// Split-x sits between the two columns.
const boundaries = new Map<number, number>([[1, 200]]);

describe("orderItemsByColumn", () => {
  it("returns a single band (all items) when boundaries are absent", () => {
    const bands = orderItemsByColumn(twoColumnItems, undefined);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toBe(twoColumnItems);
  });

  it("returns a single band when boundaries are empty", () => {
    const bands = orderItemsByColumn(twoColumnItems, new Map());
    expect(bands).toHaveLength(1);
    expect(bands[0]).toBe(twoColumnItems);
  });

  it("splits a two-column page into left band then right band", () => {
    const bands = orderItemsByColumn(twoColumnItems, boundaries);
    expect(bands).toHaveLength(2);
    expect(bands[0].every((it) => it.x < 200)).toBe(true);
    expect(bands[1].every((it) => it.x >= 200)).toBe(true);
    expect(bands[0].map((it) => it.str)).toEqual(["left-1", "left-2", "left-3"]);
    expect(bands[1].map((it) => it.str)).toEqual([
      "right-1",
      "right-2",
      "right-3",
    ]);
  });

  it("orders bands page-major: page 1 left, page 1 right, page 2…", () => {
    const items = [
      mkItem(LEFT_X, 100, "p1-left", 1),
      mkItem(RIGHT_X, 100, "p1-right", 1),
      mkItem(LEFT_X, 100, "p2-left", 2),
      mkItem(RIGHT_X, 100, "p2-right", 2),
    ];
    const b = new Map<number, number>([
      [1, 200],
      [2, 200],
    ]);
    const bands = orderItemsByColumn(items, b);
    expect(bands.map((band) => band.map((it) => it.str))).toEqual([
      ["p1-left"],
      ["p1-right"],
      ["p2-left"],
      ["p2-right"],
    ]);
  });
});

describe("groupIntoLines column awareness", () => {
  it("emits all left-column lines before all right-column lines", () => {
    const lines = groupIntoLines(twoColumnItems, boundaries);
    const texts = lines.map((l) => l.text);
    expect(texts).toEqual([
      "left-1",
      "left-2",
      "left-3",
      "right-1",
      "right-2",
      "right-3",
    ]);
  });

  it("de-interleaves an embedded multi-column run even without a page boundary (#164)", () => {
    // Before #164 this no-boundary path emitted the rows interleaved
    // L,R,L,R,L,R — a localized multi-column block (≥2 shared-baseline rows with
    // a column-sized gap) that the page-level ink-projection probe never sees,
    // so `boundaries` is empty. `reorderEmbeddedColumns` now detects the run at
    // the item level and re-emits it column-major: the whole left column, then
    // the whole right column — matching the boundary-supplied path above.
    const lines = groupIntoLines(twoColumnItems);
    const texts = lines.map((l) => l.text);
    expect(texts).toEqual([
      "left-1",
      "left-2",
      "left-3",
      "right-1",
      "right-2",
      "right-3",
    ]);
  });
});

describe("embedded multi-column reading order (#164)", () => {
  // A 3-column "Relevant Coursework" grid embedded in an otherwise single-column
  // page (column markers at x≈81 / 244 / 407, with wrapped course-name tails
  // indented a few points past their marker). The page-level probe never bands
  // this (the single-column body inks straight across its gutters), so the
  // reorder must happen at the item level. Geometry mirrors the
  // google-docs-skia-proxy-multiline-bullets-coursework fixture.
  // Realistic glyph widths (~5.2pt/char, as pdfjs emits for 11pt text) so the
  // inter-column gutters (col1→2 ≈ 244-195, col2→3 ≈ 407-356) clear the 50pt
  // column-split threshold the same way the real fixture does.
  const narrow = (x: number, y: number, str: string): PdfTextItem => ({
    page: 1,
    x,
    y,
    str,
    width: str.length * 5.0,
    height: 11,
    fontSize: 11,
    fontName: "font-11",
    hasEOL: true,
  });
  const courseworkItems: PdfTextItem[] = [
    narrow(81, 695, "● Global Dimensions of"),
    narrow(244, 695, "● Financial Accounting"),
    narrow(407, 695, "● Microeconomics"),
    narrow(90, 709, "Business"), // wrap of col-1 row-1
    narrow(244, 711, "● Fundamentals of"),
    narrow(407, 711, "● Macroeconomics"),
    narrow(81, 724, "● Fundamentals of HR"),
    narrow(253, 724, "Operational Management"), // wrap of col-2 row-2
    narrow(407, 726, "● Legal Environment of"),
    narrow(90, 738, "Management"), // wrap of col-1 row-3
    narrow(416, 739, "Business"), // wrap of col-3 row-3
  ];

  it("emits each column top-to-bottom, columns left-to-right (not row zig-zag)", () => {
    const lines = groupIntoLines(courseworkItems);
    const texts = lines.map((l) => l.text);
    // Column-major: every column-1 line (incl. its wrap), then column-2, then
    // column-3. A row-major (y, x) sort would interleave them — the bug.
    expect(texts).toEqual([
      "● Global Dimensions of",
      "Business",
      "● Fundamentals of HR",
      "Management",
      "● Financial Accounting",
      "● Fundamentals of",
      "Operational Management",
      "● Microeconomics",
      "● Macroeconomics",
      "● Legal Environment of",
      "Business",
    ]);
    // Guard against regression to interleaving: column-1's wrap ("Business",
    // the second line) must precede any column-3 content.
    expect(texts.indexOf("● Microeconomics")).toBeGreaterThan(
      texts.indexOf("● Global Dimensions of"),
    );
    expect(texts.indexOf("● Microeconomics")).toBeGreaterThan(
      texts.indexOf("● Financial Accounting"),
    );
  });

  it("leaves a single-column block untouched (no spurious reorder)", () => {
    const singleCol: PdfTextItem[] = [
      mkItem(72, 100, "first line of body text"),
      mkItem(72, 114, "second line of body text"),
      mkItem(72, 128, "third line of body text"),
    ];
    const texts = groupIntoLines(singleCol).map((l) => l.text);
    expect(texts).toEqual([
      "first line of body text",
      "second line of body text",
      "third line of body text",
    ]);
  });

  it("does not reorder an isolated single multi-column row (date rail)", () => {
    // One header line with a right-aligned date — a single multi-column row,
    // below the ≥2-row run threshold, so it must NOT be treated as a column
    // grid and reordered away from the body that follows it.
    const dateRail: PdfTextItem[] = [
      mkItem(72, 100, "Senior Engineer, Acme Corp"),
      mkItem(420, 100, "2020 – 2023"),
      mkItem(72, 116, "● Built the thing that did the stuff"),
      mkItem(72, 132, "● Shipped it on time"),
    ];
    const texts = groupIntoLines(dateRail).map((l) => l.text);
    // The row is not reordered (the body is not pulled above the date). The
    // trailing right-aligned date range now stays MERGED onto the header row via
    // the #425 flush()-exemption — a lone trailing date range is kept on the org
    // line rather than split off at the column gap, so the org keeps its date
    // anchor on re-parse — and the bullets follow in order.
    expect(texts[0]).toBe("Senior Engineer, Acme Corp 2020 – 2023");
    expect(texts.slice(1)).toEqual([
      "● Built the thing that did the stuff",
      "● Shipped it on time",
    ]);
  });
});

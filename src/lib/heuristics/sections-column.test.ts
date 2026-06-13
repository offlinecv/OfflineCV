// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

  it("interleaves by (y, x) when no boundary is supplied (legacy path)", () => {
    const lines = groupIntoLines(twoColumnItems);
    // Shared baselines split at the wide column gap, so the global (y, x) sort
    // emits the rows interleaved L, R, L, R… — the scrambling this fix targets.
    const texts = lines.map((l) => l.text);
    expect(texts).toEqual([
      "left-1",
      "right-1",
      "left-2",
      "right-2",
      "left-3",
      "right-3",
    ]);
  });
});

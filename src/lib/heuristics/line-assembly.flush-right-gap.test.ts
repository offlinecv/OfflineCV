// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `splitOnFlushRightGap` — the geometry half of the tab-justified flush-right
 * fix (#891).
 *
 * Geometry mirrors the real PDF row from the issue: `"Software Developer"` at
 * x≈41.76, a single whitespace-only text item ~415pt wide spanning the
 * justification, then `"Remote"` at x≈539.95. The two adjacent-pair gaps are
 * ~0 — that is exactly why `columnGapCuts` cannot see this shape — so the
 * helper keys on the blank item's own declared `width` instead.
 */

import { describe, it, expect } from "vitest";
import { splitOnFlushRightGap } from "./line-assembly.ts";
import type { PdfTextItem } from "./types.ts";

/** Item at `x` whose declared width is `width` — the two numbers the helper
 *  reads. Everything else is inert filler. */
function item(str: string, x: number, width: number): PdfTextItem {
  return {
    page: 1,
    str,
    x,
    y: 114,
    width,
    height: 11,
    fontSize: 11,
    fontName: "font-11",
    hasEOL: true,
  };
}

// The issue's row, verbatim: title ends at 124.66, the blank run spans
// 124.66 → 539.95 (415.29pt), "Remote" starts where the blank run ends. No
// real gap between any adjacent pair.
const TITLE = item("Software Developer", 41.76, 82.9);
const BLANK = item("                              ", 124.66, 415.29);
const REMOTE = item("Remote", 539.95, 32.05);

describe("splitOnFlushRightGap (#891)", () => {
  it("splits a tab-justified row at the wide whitespace-only item", () => {
    const split = splitOnFlushRightGap([TITLE, BLANK, REMOTE]);
    expect(split).toBeDefined();
    expect(split?.head).toEqual([TITLE]);
    expect(split?.trailer).toEqual([REMOTE]);
  });

  it("keeps every item on the correct side when each cell is multi-run", () => {
    const lead = item("Software", 41.76, 45);
    const rest = item("Developer", 88, 48);
    const city = item("Bellevue,", 500, 40);
    const state = item("WA", 542, 14);
    const split = splitOnFlushRightGap([lead, rest, BLANK, city, state]);
    expect(split?.head).toEqual([lead, rest]);
    expect(split?.trailer).toEqual([city, state]);
  });

  it("returns undefined when the row carries no whitespace-only item", () => {
    expect(splitOnFlushRightGap([TITLE, REMOTE])).toBeUndefined();
  });

  it("returns undefined for ordinary inter-word spacing below the column threshold", () => {
    // A 33pt blank is word/run spacing, not a justification rail — the same
    // 50pt `COLUMN_GAP_THRESHOLD` the line splitter uses gates both.
    const narrow = item("      ", 124.66, 33);
    expect(splitOnFlushRightGap([TITLE, narrow, REMOTE])).toBeUndefined();
  });

  it("returns undefined for a leading or trailing blank item (padding, not a separator)", () => {
    expect(splitOnFlushRightGap([BLANK, TITLE, REMOTE])).toBeUndefined();
    expect(splitOnFlushRightGap([TITLE, REMOTE, BLANK])).toBeUndefined();
  });

  it("returns undefined for a row of fewer than three items", () => {
    expect(splitOnFlushRightGap([])).toBeUndefined();
    expect(splitOnFlushRightGap([BLANK])).toBeUndefined();
    expect(splitOnFlushRightGap([TITLE, BLANK])).toBeUndefined();
  });

  it("splits at the FIRST qualifying blank when a row carries several", () => {
    const second = item("                    ", 572, 60);
    const tail = item("Hybrid", 632, 30);
    const split = splitOnFlushRightGap([TITLE, BLANK, REMOTE, second, tail]);
    expect(split?.head).toEqual([TITLE]);
    expect(split?.trailer).toEqual([REMOTE, second, tail]);
  });
});

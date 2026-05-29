// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import { assembleTextFromLines } from "./pdf-extract.ts";
import type { PdfTextItem } from "./types.ts";

function item(
  str: string,
  x: number,
  y: number,
  page = 1,
  width = 50,
): PdfTextItem {
  return {
    page,
    str,
    x,
    y,
    width,
    height: 12,
    fontSize: 11,
    fontName: "Helvetica",
    hasEOL: false,
  };
}

describe("assembleTextFromLines", () => {
  it("inserts a newline between lines that share a page but differ in y", () => {
    const items = [
      item("Education", 72, 100),
      item("Stanford", 72, 120),
      item("BS Computer Science", 72, 135),
    ];
    expect(assembleTextFromLines(items).split("\n")).toEqual([
      "Education",
      "Stanford",
      "BS Computer Science",
    ]);
  });

  it("preserves bullet glyphs at the start of a line", () => {
    // pdfjs typically emits the bullet glyph as a separate item just left of
    // the bullet text; both share the same y.
    const items = [
      item("•", 72, 200, 1, 6),
      item("Led migration of legacy auth system", 90, 200),
      item("•", 72, 215, 1, 6),
      item("Drove 30% revenue growth", 90, 215),
    ];
    const text = assembleTextFromLines(items);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^•\s+Led migration/);
    expect(lines[1]).toMatch(/^•\s+Drove 30% revenue/);
  });

  it("inserts a blank line between pages", () => {
    const items = [
      item("Page 1 last line", 72, 700, 1),
      item("Page 2 first line", 72, 100, 2),
    ];
    expect(assembleTextFromLines(items)).toBe(
      "Page 1 last line\n\nPage 2 first line",
    );
  });

  it("returns empty string for empty input (scanned PDFs)", () => {
    expect(assembleTextFromLines([])).toBe("");
  });
});

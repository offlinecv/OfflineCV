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

  it("splits two-column same-y items so right-column bullets keep line-start position (issue #9)", () => {
    // Deedy-style two-column layout: left column has education text, right
    // column has experience bullets, both at the same baseline y. Pre-fix
    // groupIntoLines merged them into a single PdfLine like
    //   "BS in Computer Science                            • Led migration"
    // which dropped the bullet glyph out of line-start position and the
    // score-side bullet counter missed it. The 50pt column-gap split keeps
    // each column on its own line.
    const items = [
      // Left column: education text starting at x=35
      item("BS in Computer Science", 35, 200, 1, 120),
      // Right column: experience bullet starting at x=300 — 145pt gap
      item("•", 300, 200, 1, 6),
      item("Led migration of legacy auth system", 315, 200, 1, 200),
    ];
    const text = assembleTextFromLines(items);
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("BS in Computer Science");
    expect(lines[1]).toMatch(/^•\s+Led migration/);
  });

  it("does NOT split a normal single-column line at small gaps", () => {
    // Regression guard: a tightly-laid-out single-column line with normal
    // word/run spacing (gaps well under 50pt) must stay as one PdfLine,
    // otherwise we'd fragment every Awesome-CV / OpenResume-style PDF.
    const items = [
      item("Jane", 72, 100, 1, 30),
      item("Smith", 110, 100, 1, 35),       // ~8pt gap
      item("Senior Engineer", 160, 100, 1, 100),  // ~15pt gap
    ];
    expect(assembleTextFromLines(items)).toBe("Jane Smith Senior Engineer");
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the PDF → markdown emitter. Covers the exported utility
 * functions individually plus end-to-end `emitMarkdown()` scenarios.
 */

import {
  computeBodyFontSize,
  emitMarkdown,
  groupItemsIntoLines,
  isBulletLine,
  needsParagraphBreak,
  renderLine,
  stripBulletPrefix,
} from "./markdown-emit.ts";
import { mkDefaultPages, mkItems } from "./__test-utils__/mkItem.ts";
import type { RenderLine } from "./markdown-emit.ts";

describe("markdown-emit: groupItemsIntoLines", () => {
  it("returns empty array on empty input", () => {
    expect(groupItemsIntoLines([])).toEqual([]);
  });

  it("groups items at the same y-coord into one line", () => {
    const items = mkItems([
      { text: "Hello ", lineIndex: 0, x: 72 },
      { text: "world", lineIndex: 0, x: 110 },
    ]);
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Hello world");
  });

  it("separates items on different y-coords", () => {
    const items = mkItems([
      { text: "Line one", lineIndex: 0 },
      { text: "Line two", lineIndex: 1 },
    ]);
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(["Line one", "Line two"]);
  });

  it("uses the max font size when items on a line have differing sizes", () => {
    const items = mkItems([
      { text: "small ", lineIndex: 0, fontSize: 10 },
      { text: "BOLD", lineIndex: 0, x: 110, fontSize: 10 },
    ]);
    const lines = groupItemsIntoLines(items);
    expect(lines[0].fontSize).toBe(10);
  });
});

describe("markdown-emit: computeBodyFontSize", () => {
  it("returns default 10 for empty input", () => {
    expect(computeBodyFontSize([])).toBe(10);
  });

  it("picks the character-weighted mode, not the line-count mode", () => {
    // Two short 18pt header lines and three long 11pt body lines. Character
    // weighting should pick 11pt even though there are almost equal counts.
    const lines: RenderLine[] = [
      { page: 1, y: 72, x: 72, text: "HEAD", fontSize: 18 },
      { page: 1, y: 100, x: 72, text: "HEAD2", fontSize: 18 },
      {
        page: 1, y: 120, x: 72,
        text: "this is a much longer line of body text that should dominate",
        fontSize: 11,
      },
      {
        page: 1, y: 134, x: 72,
        text: "and another long body paragraph line keeps the weight on 11pt",
        fontSize: 11,
      },
      {
        page: 1, y: 148, x: 72,
        text: "third body line for good measure keeps the mode at 11",
        fontSize: 11,
      },
    ];
    expect(computeBodyFontSize(lines)).toBe(11);
  });
});

describe("markdown-emit: isBulletLine / stripBulletPrefix", () => {
  it("detects common bullet glyphs", () => {
    expect(isBulletLine("• Drove revenue 30%")).toBe(true);
    expect(isBulletLine("- Shipped v2")).toBe(true);
    expect(isBulletLine("* Shipped v2")).toBe(true);
    expect(isBulletLine("▪ Shipped v2")).toBe(true);
    expect(isBulletLine("◦ Shipped v2")).toBe(true);
    expect(isBulletLine("\uF0B7 Wingdings bullet")).toBe(true);
  });

  it("rejects lines that do not start with a bullet glyph + space", () => {
    expect(isBulletLine("Experience")).toBe(false);
    expect(isBulletLine("*asterisk without space")).toBe(false);
    expect(isBulletLine("-hyphen without space")).toBe(false);
  });

  it("strips the leading bullet and whitespace", () => {
    expect(stripBulletPrefix("• Drove revenue 30%")).toBe("Drove revenue 30%");
    expect(stripBulletPrefix("  - Shipped v2")).toBe("Shipped v2");
    expect(stripBulletPrefix("\uF0B7 Wingdings item")).toBe("Wingdings item");
  });
});

describe("markdown-emit: renderLine", () => {
  const bodySize = 10;
  const line = (text: string, fontSize: number): RenderLine => ({
    page: 1, y: 100, x: 72, text, fontSize,
  });

  it("promotes to # H1 at ratio >= 1.5", () => {
    expect(renderLine(line("TITLE", 16), bodySize)).toBe("# TITLE");
  });

  it("promotes to ## H2 at ratio >= 1.25", () => {
    expect(renderLine(line("Section", 13), bodySize)).toBe("## Section");
  });

  it("promotes to ### H3 at ratio >= 1.12", () => {
    expect(renderLine(line("Subsection", 12), bodySize)).toBe("### Subsection");
  });

  it("renders plain prose at body size", () => {
    expect(renderLine(line("body text", 10), bodySize)).toBe("body text");
  });

  it("renders bullet lines as markdown list items", () => {
    expect(renderLine(line("• did a thing", 10), bodySize)).toBe("- did a thing");
  });

  it("heading promotion wins over bullet detection", () => {
    expect(renderLine(line("• BIG HEADER", 16), bodySize)).toBe("# • BIG HEADER");
  });
});

describe("markdown-emit: needsParagraphBreak", () => {
  const body = 10;
  const line = (page: number, y: number, fontSize = body): RenderLine => ({
    page, y, x: 72, text: "x", fontSize,
  });

  it("breaks on page change", () => {
    expect(needsParagraphBreak(line(1, 700), line(2, 72), body)).toBe(true);
  });

  it("breaks on large y-gap", () => {
    expect(needsParagraphBreak(line(1, 100), line(1, 100 + body * 2), body)).toBe(true);
  });

  it("does not break on normal line spacing", () => {
    expect(needsParagraphBreak(line(1, 100), line(1, 114), body)).toBe(false);
  });

  it("breaks on font-size change (header transition)", () => {
    expect(needsParagraphBreak(line(1, 100, 10), line(1, 114, 14), body)).toBe(true);
  });
});

describe("markdown-emit: emitMarkdown end-to-end", () => {
  it("returns undefined for empty input", () => {
    expect(emitMarkdown([], [])).toBeUndefined();
  });

  it("returns undefined when too few lines to produce structure", () => {
    const items = mkItems([
      { text: "Hi", lineIndex: 0 },
      { text: "there", lineIndex: 1 },
    ]);
    expect(emitMarkdown(items, mkDefaultPages(items))).toBeUndefined();
  });

  it("renders a simple resume with headings, bullets, and body prose", () => {
    const items = mkItems([
      { text: "Priya Ramachandran", lineIndex: 0, fontSize: 18 },
      { text: "priya@example.com · (555) 123-4567", lineIndex: 1, fontSize: 10 },
      { text: "Experience", lineIndex: 3, fontSize: 14 },
      { text: "Staff Engineer, Stripe", lineIndex: 4, fontSize: 11 },
      { text: "2019–2023", lineIndex: 5, fontSize: 10 },
      { text: "• Shipped v2 of payments API", lineIndex: 6, fontSize: 10 },
      { text: "• Drove revenue 30%", lineIndex: 7, fontSize: 10 },
    ]);
    const md = emitMarkdown(items, mkDefaultPages(items));
    expect(md).toBeDefined();
    expect(md).toContain("# Priya Ramachandran");
    expect(md).toContain("## Experience");
    expect(md).toContain("- Shipped v2 of payments API");
    expect(md).toContain("- Drove revenue 30%");
  });

  it("inserts blank lines at page breaks", () => {
    const items = mkItems([
      { text: "first line", lineIndex: 0, page: 1 },
      { text: "second line", lineIndex: 1, page: 1 },
      { text: "third line on page 2", lineIndex: 0, page: 2 },
    ]);
    const md = emitMarkdown(items, mkDefaultPages(items))!;
    const lines = md.split("\n");
    // "first line" \n "second line" \n "" \n "third line on page 2"
    expect(lines).toContain("");
    expect(lines[lines.length - 1]).toContain("third line on page 2");
  });

  it("collapses runs of blank lines to a maximum of one", () => {
    const items = mkItems([
      { text: "A section", lineIndex: 0, fontSize: 14, page: 1 },
      { text: "body", lineIndex: 1, fontSize: 10, page: 1 },
      { text: "more body text", lineIndex: 2, fontSize: 10, page: 1 },
      { text: "another line of body text here", lineIndex: 3, fontSize: 10, page: 1 },
      { text: "next page header", lineIndex: 0, fontSize: 14, page: 2 },
    ]);
    const md = emitMarkdown(items, mkDefaultPages(items))!;
    expect(md).not.toMatch(/\n{3,}/);
  });
});

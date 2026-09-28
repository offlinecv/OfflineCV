// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the PDF → markdown emitter. Covers the exported utility
 * functions individually, the `emitMarkdownFromLines` heading-identity
 * contract (#651), and end-to-end `emitMarkdown()` scenarios.
 */

import {
  emitMarkdown,
  emitMarkdownFromLines,
  isBulletLine,
  needsParagraphBreak,
  renderLine,
  stripBulletPrefix,
} from "./markdown-emit.ts";
import { computeBodyFontSize, groupIntoLines } from "./line-assembly.ts";
import type { PdfLine } from "./line-model.ts";
import { mkDefaultPages, mkItems } from "./__test-utils__/mkItem.ts";

/** A `PdfLine` literal with only the fields the emitter reads filled in. */
function line(
  text: string,
  maxFontSize: number,
  extra: Partial<Pick<PdfLine, "page" | "y" | "x">> = {},
): PdfLine {
  return {
    page: extra.page ?? 1,
    y: extra.y ?? 100,
    x: extra.x ?? 72,
    items: [],
    text,
    maxFontSize,
    allCaps: text === text.toUpperCase(),
    gapAbove: 0,
  };
}

describe("markdown-emit: computeBodyFontSize", () => {
  it("returns default 10 for empty input", () => {
    expect(computeBodyFontSize([])).toBe(10);
  });

  it("picks the character-weighted mode, not the line-count mode", () => {
    // Two short 18pt header lines and three long 11pt body lines. Character
    // weighting should pick 11pt even though there are almost equal counts.
    const lines = [
      line("HEAD", 18, { y: 72 }),
      line("HEAD2", 18, { y: 100 }),
      line("this is a much longer line of body text that should dominate", 11, { y: 120 }),
      line("and another long body paragraph line keeps the weight on 11pt", 11, { y: 134 }),
      line("third body line for good measure keeps the mode at 11", 11, { y: 148 }),
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
    expect(isBulletLine(" Wingdings bullet")).toBe(true);
  });

  it("rejects lines that do not start with a bullet glyph + space", () => {
    expect(isBulletLine("Experience")).toBe(false);
    expect(isBulletLine("*asterisk without space")).toBe(false);
    expect(isBulletLine("-hyphen without space")).toBe(false);
  });

  it("strips the leading bullet and whitespace", () => {
    expect(stripBulletPrefix("• Drove revenue 30%")).toBe("Drove revenue 30%");
    expect(stripBulletPrefix("  - Shipped v2")).toBe("Shipped v2");
    expect(stripBulletPrefix(" Wingdings item")).toBe("Wingdings item");
  });
});

describe("markdown-emit: renderLine", () => {
  const bodySize = 10;

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
  const at = (page: number, y: number, fontSize = body) =>
    line("x", fontSize, { page, y });

  it("breaks on page change", () => {
    expect(needsParagraphBreak(at(1, 700), at(2, 72), body)).toBe(true);
  });

  it("breaks on large y-gap", () => {
    expect(needsParagraphBreak(at(1, 100), at(1, 100 + body * 2), body)).toBe(true);
  });

  it("does not break on normal line spacing", () => {
    expect(needsParagraphBreak(at(1, 100), at(1, 114), body)).toBe(false);
  });

  it("breaks on font-size change (header transition)", () => {
    expect(needsParagraphBreak(at(1, 100, 10), at(1, 114, 14), body)).toBe(true);
  });
});

describe("markdown-emit: emitMarkdownFromLines shares line objects with the parser (#651)", () => {
  it("reports promoted headings as the very PdfLine objects it was given", () => {
    const lines = groupIntoLines(
      mkItems([
        { text: "Priya Ramachandran", fontSize: 18 },
        { text: "priya@example.com · (312) 555-0123", fontSize: 10 },
        { text: "Experience", fontSize: 14 },
        { text: "Staff Engineer, Stripe", fontSize: 11 },
        { text: "• Shipped v2 of payments API for the platform team", fontSize: 10 },
        { text: "• Drove revenue 30% through pricing experiments", fontSize: 10 },
        { text: "Education", fontSize: 14 },
        { text: "B.S. Computer Science, State University", fontSize: 10 },
      ]),
    );
    const emission = emitMarkdownFromLines(lines)!;
    expect(emission).toBeDefined();

    // Every heading is one of the input objects — identity, not a copy.
    for (const h of emission.headings) {
      expect(lines.some((l) => l === h)).toBe(true);
    }
    // And the heading set is exactly the lines that rendered as `#…` lines.
    const rendered = emission.markdown
      .split("\n")
      .filter((l) => /^#{1,3} /.test(l))
      .map((l) => l.replace(/^#{1,3} /, ""));
    expect([...emission.headings].map((l) => l.text)).toEqual(rendered);
    expect(rendered).toEqual(["Priya Ramachandran", "Experience", "Education"]);
    expect(emission.headings.has(lines[2])).toBe(true);
    expect(emission.headings.has(lines[3])).toBe(false);
  });

  it("skips empty-text lines and does not count them toward the minimum", () => {
    // The shared assembler keeps a line for a whitespace-only item; the
    // private grouper this replaced dropped it. Two real lines plus a blank one
    // must still be "too sparse".
    const lines = groupIntoLines(
      mkItems([{ text: "Hi" }, { text: "   " }, { text: "there" }]),
    );
    expect(lines).toHaveLength(3);
    expect(emitMarkdownFromLines(lines)).toBeUndefined();

    const dense = groupIntoLines(
      mkItems([{ text: "Hi" }, { text: "   " }, { text: "there" }, { text: "friend" }]),
    );
    const md = emitMarkdownFromLines(dense)!.markdown;
    expect(md.split("\n").filter((l) => l.length > 0)).toEqual(["Hi", "there", "friend"]);
  });

  it("renders a heading cleanly when a right-column value shares its baseline", () => {
    // Same row, >50pt gap: the shared assembler cuts the row into two lines
    // (`columnGapCuts`), so the heading text is "EXPERIENCE" and not
    // "EXPERIENCE Python". The old private grouper welded them.
    const lines = groupIntoLines(
      mkItems([
        { text: "Jordan Reyes", lineIndex: 0, fontSize: 18 },
        { text: "jordan@example.com", lineIndex: 1, fontSize: 10 },
        { text: "EXPERIENCE", lineIndex: 2, x: 72, fontSize: 13 },
        { text: "Python", lineIndex: 2, x: 400, fontSize: 10 },
        { text: "Engineer at Globex, building billing systems", lineIndex: 3, fontSize: 10 },
      ]),
    );
    const emission = emitMarkdownFromLines(lines)!;
    const heading = [...emission.headings].find((l) => l.text === "EXPERIENCE");
    expect(heading).toBeDefined();
    expect(emission.markdown).toContain("## EXPERIENCE");
    expect(emission.markdown).not.toContain("EXPERIENCE Python");
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
      { text: "priya@example.com · (312) 555-0123", lineIndex: 1, fontSize: 10 },
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

  it("joins same-baseline items with an inferred space, so a split bullet still lists", () => {
    // pdfjs often emits the glyph and the text as separate items. Raw
    // concatenation gave "•Shipped", which fails the bullet regex's `\s+`.
    const items = mkItems([
      { text: "Priya Ramachandran", lineIndex: 0, fontSize: 18 },
      { text: "priya@example.com", lineIndex: 1, fontSize: 10 },
      { text: "•", lineIndex: 2, x: 72, fontSize: 10 },
      { text: "Shipped v2 of payments API", lineIndex: 2, x: 84, fontSize: 10 },
      { text: "more body text on the next line", lineIndex: 3, fontSize: 10 },
    ]);
    const md = emitMarkdown(items, mkDefaultPages(items))!;
    expect(md).toContain("- Shipped v2 of payments API");
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

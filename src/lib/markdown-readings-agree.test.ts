// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The "two readings of one `.md` agree" invariant, asserted directly.
 *
 * A dropped `.md` is read twice: `markdown-lines.ts` turns it into `PdfLine[]`
 * for the extractors, and `ingest/markdown.ts`'s `mdToPlainText` flattens it
 * into the `rawText` the scorer scans and `EvidencePanel` prints back to the
 * user verbatim. Three docblocks assert those readings agree (#610, #611) — and
 * nothing checked it. The gap was real: `mdToPlainText` had the reference rules
 * but not the autolink rule and its inline rule was not title-aware, so the
 * SAME fixture line read `<https://linkedin.com/in/…>` and
 * `…/pricing-writeup "Pricing rebuild"` on the `rawText` side while the
 * extractors saw the flattened form.
 *
 * The existing repro tests could not catch it: they scan `visibleStrings()`,
 * which is built from the parsed canonical fields and so never touches
 * `rawText`. This compares the two readings against each other, line for line,
 * over both markdown fixtures.
 *
 * THE ONE DELIBERATE DIFFERENCE. `markdown-lines.ts` keeps a bullet's leading
 * `- ` so the shared `isBulletLine` extractor matches; `mdToPlainText` strips it
 * because the scorer wants prose. Normalizing that marker away is therefore
 * part of the invariant, not a concession to it — every other character must
 * match exactly.
 */

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sectionizeMarkdown } from "./heuristics/markdown-lines.ts";
import { mdToPlainText } from "./ingest/markdown.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "../../tests/fixtures/markdown");

/** Drop the bullet marker and blank lines — the only sanctioned divergence. */
function normalize(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*[-*+]\s+/, "").trim())
    .filter((l) => l.length > 0);
}

function readings(markdown: string): { mdLines: string[]; rawText: string[] } {
  return {
    mdLines: normalize(sectionizeMarkdown(markdown).lines.map((l) => l.text)),
    rawText: normalize(mdToPlainText(markdown).split("\n")),
  };
}

describe.each(["inline-links", "reference-links"])(
  "%s.md — the PdfLine reading and the rawText reading agree",
  (name) => {
    let markdown: string;

    beforeAll(async () => {
      markdown = await fsp.readFile(join(FIXTURE_DIR, `${name}.md`), "utf8");
    });

    it("produces identical lines from both readings", () => {
      const { mdLines, rawText } = readings(markdown);
      expect(rawText).toEqual(mdLines);
    });

    it("leaves no link syntax in either reading", () => {
      const { mdLines, rawText } = readings(markdown);
      for (const line of [...mdLines, ...rawText]) {
        expect(line).not.toMatch(/<https?:/); // autolink
        expect(line).not.toMatch(/<[^<>\s@]+@[^<>\s@]+>/); // email autolink
        expect(line).not.toMatch(/\]\s*\(/); // inline link
        expect(line).not.toMatch(/^\s{0,3}\[[^\]\n]+\]:/); // definition line
        expect(line).not.toMatch(/"Pricing rebuild"/); // CommonMark title
      }
    });
  },
);

describe("a DEFINED reference-style image never leaks its URL in EITHER reading", () => {
  // #610's criterion "images still strip entirely" holds for the inline shape
  // `![alt](url)`; #611's reference table reopened it in the reference shape,
  // which resolved to `!alt url` and injected an image URL into body text.
  //
  // The title says DEFINED because that is the whole population this covers: an
  // image reference with no matching definition is literal text, not an image
  // (see the sibling describe below). Within that population the cases are the
  // full alt-text alphabet — plain, empty, and BRACKET-BEARING, the last being
  // where an alt class that stops at the first inner `]` left a `[logo]` tail
  // behind for shortcut resolution to turn back into a URL.
  const DEF = "\n\n[logo]: https://example.org/logo.png";

  it.each([
    ["full reference", `![Company logo][logo]${DEF}`],
    ["collapsed reference", `![logo][]${DEF}`],
    ["shortcut reference", `![logo]${DEF}`],
    ["bracketed alt text", `![a [b] c][logo]${DEF}`],
    ["empty alt text", `![][logo]${DEF}`],
  ])("%s never flattens to `alt url` (PdfLine reading)", (_label, markdown) => {
    const texts = sectionizeMarkdown(markdown).lines.map((l) => l.text);
    // The image is stripped outright and the definition line is blanked, so
    // the document has no content lines at all.
    expect(texts).toEqual([]);
  });

  it.each([
    ["full reference", `![Company logo][logo]${DEF}`, "![Company logo][logo]"],
    ["collapsed reference", `![logo][]${DEF}`, "![logo][]"],
    ["shortcut reference", `![logo]${DEF}`, "![logo]"],
    ["bracketed alt text", `![a [b] c][logo]${DEF}`, "![a [b] c][logo]"],
    ["empty alt text", `![][logo]${DEF}`, "![][logo]"],
  ])(
    "%s stays literal, URL-free markdown (rawText reading)",
    (_label, markdown, literal) => {
      const raw = mdToPlainText(markdown);
      expect(raw).toContain(literal);
      // Neither the image URL nor a stray `!alt url` reaches the text.
      expect(raw).not.toContain("https://example.org/logo.png");
    },
  );

  it("keeps a bracket-bearing alt inert INSIDE a prose line", () => {
    // Standalone, the leak shows up as a whole line; mid-sentence it shows up
    // as a URL spliced into résumé body text, which is the shape that reaches
    // the scorer and the Evidence panel.
    const markdown = `Team ![a [b] c][logo] shipped${DEF}`;
    const mdLine = sectionizeMarkdown(markdown).lines.map((l) => l.text);
    const raw = mdToPlainText(markdown);
    expect(mdLine.join("\n")).not.toContain("https://example.org/logo.png");
    expect(raw).not.toContain("https://example.org/logo.png");
  });

  it("still resolves a NON-image reference sharing the shape", () => {
    // Guards the `(!?)` capture against over-claiming: drop the `!` and the
    // very same input must resolve.
    expect(mdToPlainText(`[Company logo][logo]${DEF}`)).toContain(
      "Company logo https://example.org/logo.png",
    );
    expect(
      sectionizeMarkdown(`[Company logo][logo]${DEF}`).lines.map((l) => l.text),
    ).toEqual(["Company logo https://example.org/logo.png"]);
  });
});

describe("an UNDEFINED reference-style image is literal text, not an image", () => {
  // The image strip deleted `![anything]` outright, with no definition-table
  // lookup — so ordinary prose carrying a `!` next to a bracket silently lost
  // characters the PDF/plain-text paths keep, and the two readings disagreed
  // about it (`rawText` kept the text; the `PdfLine` reading deleted it).
  //
  // CommonMark is explicit that an image reference with no matching definition
  // IS literal text — the same rule `resolveReferenceLinks` already applies to
  // an undefined LINK label, and the same rule that protects a bracketed year
  // marker like `[2019]` from being read as a link.
  it.each([
    ["shortcut", "Wow![great] news"],
    ["full", "Grew revenue 40%![details][cat]"],
    ["collapsed", "Sold 3x![units][] last year"],
  ])("%s reference survives verbatim in both readings", (_label, markdown) => {
    expect(sectionizeMarkdown(markdown).lines.map((l) => l.text)).toEqual([
      markdown,
    ]);
    expect(mdToPlainText(markdown)).toBe(markdown);
  });

  it("resolves only the ones the definition table actually defines", () => {
    // Same document, same shape, one defined and one not: the defined image
    // strips, the undefined one stays as the author typed it.
    const markdown =
      "Wow![great] news ![badge][ci]\n\n[ci]: https://example.org/ci.svg";
    const mdLine = sectionizeMarkdown(markdown).lines.map((l) => l.text);
    expect(mdLine.join("\n")).toContain("Wow![great] news");
    expect(mdLine.join("\n")).not.toContain("![badge][ci]");
    expect(mdLine.join("\n")).not.toContain("https://example.org/ci.svg");
    expect(mdToPlainText(markdown)).not.toContain("https://example.org/ci.svg");
  });
});

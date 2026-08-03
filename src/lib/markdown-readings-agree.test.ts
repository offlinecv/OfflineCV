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
 * #613 closed the last shape the two readings disagreed on: an INLINE image.
 * `markdown-lines.ts` stripped it; `mdToPlainText` had no image rule at all, so
 * the image's `[alt](url)` tail matched its generic LINK rule and flattened to
 * `!alt url` — an image URL (or a base64 payload) printed to the user by
 * `EvidencePanel` and scanned by the scorer. Neither fixture contained an image
 * at the time, which is why the line-for-line comparison above saw nothing;
 * `inline-links.md` now carries both forms.
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

describe("inline-links.md — an inline image contributes nothing to either reading", () => {
  // #613. The fixture carries both shapes: a base64 data-URI headshot in the
  // profile band (mammoth+turndown's output for an embedded image) and an
  // https badge sitting immediately after a real link in Projects.
  //
  // The badge's placement is the load-bearing part. `mdToPlainText` had no
  // image rule, so the image's `[alt](url)` tail matched its generic LINK rule
  // and flattened to `!alt url` — putting an image URL in the text
  // `EvidencePanel` prints back. Next to a genuine link, a fix that
  // over-claims would take the link with it.
  let markdown: string;

  beforeAll(async () => {
    markdown = await fsp.readFile(join(FIXTURE_DIR, "inline-links.md"), "utf8");
  });

  it("leaks neither image URL, nor its alt text, nor a stray `!`", () => {
    const { mdLines, rawText } = readings(markdown);
    for (const line of [...mdLines, ...rawText]) {
      expect(line).not.toContain("data:image/png;base64");
      expect(line).not.toContain("badges/ledger-toolkit.svg");
      expect(line).not.toContain("build status");
      expect(line).not.toContain("Headshot");
      expect(line).not.toMatch(/!\[|!\w/); // `![alt](…)` residue, and `!alt url`
    }
  });

  it("still flattens the link the badge sits next to", () => {
    const { mdLines, rawText } = readings(markdown);
    for (const lines of [mdLines, rawText]) {
      expect(lines.join("\n")).toContain(
        "ledger-toolkit https://example.org/ledger-toolkit",
      );
    }
  });
});

describe("an INLINE image is inert in both readings", () => {
  // #613. `markdown-lines.ts` had stripped these since #552; `mdToPlainText`
  // never had the rule, so one file read two ways disagreed about images —
  // the last shape left over after #610/#611 aligned every LINK shape.
  //
  // Both readings are asserted for every case: the defect was invisible on the
  // `PdfLine` side, so a one-sided test would have passed against the bug.
  it.each([
    ["https image", "Shipped ![Company logo](https://example.org/logo.png) fast."],
    ["data-URI image", "Shipped ![logo](data:image/png;base64,iVBORw0KGgo=) fast."],
    ["empty alt text", "Shipped ![](https://example.org/logo.png) fast."],
    ["title-bearing image", 'Shipped ![logo](https://example.org/l.png "Logo") fast.'],
  ])("%s leaves only the surrounding prose", (_label, markdown) => {
    for (const reading of [
      mdToPlainText(markdown),
      sectionizeMarkdown(markdown).lines.map((l) => l.text).join("\n"),
    ]) {
      expect(reading).not.toContain("example.org");
      expect(reading).not.toContain("data:image");
      expect(reading).not.toContain("!");
      expect(reading).toContain("Shipped");
      expect(reading).toContain("fast.");
    }
  });

  it("strips a data URI that turndown wrapped across a line break", () => {
    // The reason both readings apply the strip to the WHOLE document rather
    // than per line. A per-line strip leaves the two halves of the payload
    // behind, and `rawText` is the reading where that lands in front of a user.
    const markdown =
      "Badge ![b](data:image/png;base64,\niVBORw0KGgo=) here.";
    expect(mdToPlainText(markdown)).not.toContain("base64");
    expect(
      sectionizeMarkdown(markdown).lines.map((l) => l.text).join("\n"),
    ).not.toContain("base64");
  });

  it("does not claim a LINK whose label merely ends in `!`", () => {
    // The `!` has to be immediately before the `[`. `[Ship it!](url)` is a
    // link; over-claiming here would delete résumé content outright.
    const markdown = "[Ship it!](https://example.org/ship)";
    expect(mdToPlainText(markdown)).toBe("Ship it! https://example.org/ship");
    expect(sectionizeMarkdown(markdown).lines.map((l) => l.text)).toEqual([
      "Ship it! https://example.org/ship",
    ]);
  });

  it("keeps the text an image runs straight into", () => {
    // CommonMark reads `Fast![label](url)` as the text "Fast" followed by an
    // image, so the text survives and the image goes — where the pre-#613
    // `rawText` reading emitted `Fast!label https://…`.
    const markdown = "Fast![label](https://example.org/x.png)";
    expect(mdToPlainText(markdown)).toBe("Fast");
    expect(sectionizeMarkdown(markdown).lines.map((l) => l.text)).toEqual([
      "Fast",
    ]);
  });
});

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

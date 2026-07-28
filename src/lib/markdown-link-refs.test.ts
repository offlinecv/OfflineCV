// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the reference-link table (#611). The two consumers
 * (`markdown-lines.ts`, `ingest/markdown.ts`) are covered where they are, so
 * this file owns the shapes neither of them can reach through its own surface:
 * definition-line recognition and, above all, the NON-recognition that keeps
 * ordinary bracketed résumé prose from being read as a link.
 */

import { describe, it, expect } from "vitest";

import {
  extractLinkDefinitions,
  resolveReferenceLinks,
  stripReferenceImages,
} from "./markdown-link-refs.ts";

/** Round-trip helper: strip definitions, then resolve usages against them. */
const flatten = (md: string): string => {
  const { definitions, body } = extractLinkDefinitions(md);
  return resolveReferenceLinks(body, definitions);
};

describe("extractLinkDefinitions", () => {
  it("collects a definition and blanks the line it came from", () => {
    const { definitions, body } = extractLinkDefinitions(
      "Prose line\n\n[cat]: https://example.org/c\n",
    );
    expect(definitions.get("cat")).toBe("https://example.org/c");
    expect(body).toBe("Prose line\n\n\n");
  });

  it("accepts the three CommonMark title delimiters and an angle-wrapped target", () => {
    const { definitions } = extractLinkDefinitions(
      [
        '[a]: https://example.org/a "double"',
        "[b]: https://example.org/b 'single'",
        "[c]: https://example.org/c (paren)",
        "[d]: <https://example.org/d>",
      ].join("\n"),
    );
    expect([...definitions.values()]).toEqual([
      "https://example.org/a",
      "https://example.org/b",
      "https://example.org/c",
      "https://example.org/d",
    ]);
  });

  it("matches labels case-insensitively with internal whitespace collapsed", () => {
    const { definitions } = extractLinkDefinitions(
      "[Pricing   Rebuild]: https://example.net/p",
    );
    expect(definitions.get("pricing rebuild")).toBe("https://example.net/p");
  });

  it("keeps the FIRST definition when a label is defined twice", () => {
    const { definitions } = extractLinkDefinitions(
      "[a]: https://example.org/first\n[a]: https://example.org/second",
    );
    expect(definitions.get("a")).toBe("https://example.org/first");
  });

  it("tolerates CRLF without swallowing the carriage return", () => {
    const { definitions, body } = extractLinkDefinitions(
      "Prose\r\n[a]: https://example.org/a\r\nMore\r\n",
    );
    expect(definitions.get("a")).toBe("https://example.org/a");
    expect(body).toBe("Prose\r\n\r\nMore\r\n");
  });

  it("does NOT eat a prose line whose target has no scheme", () => {
    // The scheme requirement is the whole guard against reading a colon-bearing
    // résumé line as document metadata.
    const md = "[2019]: awarded the Northwind engineering prize";
    const { definitions, body } = extractLinkDefinitions(md);
    expect(definitions.size).toBe(0);
    expect(body).toBe(md);
  });

  it("does NOT eat a definition-shaped line that continues into a sentence", () => {
    const md = "[a]: https://example.org/a and then some prose";
    const { definitions, body } = extractLinkDefinitions(md);
    expect(definitions.size).toBe(0);
    expect(body).toBe(md);
  });

  it("does NOT eat a line indented four spaces (a code block, not a definition)", () => {
    const md = "    [a]: https://example.org/a";
    expect(extractLinkDefinitions(md).definitions.size).toBe(0);
  });
});

describe("resolveReferenceLinks", () => {
  it("resolves a full reference to `label url`", () => {
    expect(flatten("Led the [catalog migration][cat] work\n\n[cat]: https://example.org/c")).toBe(
      "Led the catalog migration https://example.org/c work\n\n",
    );
  });

  it("resolves a collapsed reference `[label][]` off its own label", () => {
    expect(flatten("The [Pricing Rebuild][] doc\n\n[pricing rebuild]: https://example.net/p")).toBe(
      "The Pricing Rebuild https://example.net/p doc\n\n",
    );
  });

  it("resolves a shortcut reference `[label]` off its own label", () => {
    expect(flatten("The [handbook] page\n\n[handbook]: https://example.org/h")).toBe(
      "The handbook https://example.org/h page\n\n",
    );
  });

  it("emits the bare target for a degenerate empty label", () => {
    expect(flatten("Portfolio [][p] here\n\n[p]: https://example.org/p")).toBe(
      "Portfolio https://example.org/p here\n\n",
    );
  });

  it("leaves an UNDEFINED reference exactly as written", () => {
    // CommonMark's own reading: an undefined reference is literal text.
    expect(flatten("Owned the [warehouse indexer][missing] rewrite")).toBe(
      "Owned the [warehouse indexer][missing] rewrite",
    );
  });

  it("leaves bracketed prose alone — a shortcut ref needs a definition", () => {
    // `[2019]` is the year marker the achievements extractor reads. Nothing
    // defines it, so the shortcut rule must never claim it.
    expect(flatten("Bulk editor. [2019]\n\n[cat]: https://example.org/c")).toBe(
      "Bulk editor. [2019]\n\n",
    );
  });

  it("does not let a DEFINED label bleed into an unresolvable neighbouring reference", () => {
    // The single-scan regex exists for this: were shortcuts resolved in a
    // second pass, `[a][nope]` would come back as `a https://…][nope]`.
    expect(flatten("[a][nope] here\n\n[a]: https://example.org/a")).toBe(
      "[a][nope] here\n\n",
    );
  });

  it("resolves every reference on a line, not just the first", () => {
    expect(
      flatten("[one][a] and [two][b]\n\n[a]: https://example.org/1\n[b]: https://example.org/2"),
    ).toBe("one https://example.org/1 and two https://example.org/2\n\n\n");
  });

  it("never pairs a `[` with a `]` on a later line", () => {
    expect(flatten("Opened [ a bracket\nand closed ] here\n\n[a]: https://example.org/a")).toBe(
      "Opened [ a bracket\nand closed ] here\n\n",
    );
  });

  it("is a no-op when the document defines nothing", () => {
    const text = "Owned the [warehouse indexer] rewrite [2019]";
    expect(resolveReferenceLinks(text, new Map())).toBe(text);
  });
});

describe("stripReferenceImages", () => {
  const defs = new Map([["logo", "https://example.org/logo.png"]]);

  it.each([
    ["full", "A ![Company logo][logo] B"],
    ["collapsed", "A ![logo][] B"],
    ["shortcut", "A ![logo] B"],
    ["bracket-bearing alt", "A ![a [b] c][logo] B"],
    ["empty alt", "A ![][logo] B"],
  ])("drops a %s reference the table defines", (_label, text) => {
    expect(stripReferenceImages(text, defs)).toBe("A  B");
  });

  it.each([
    ["shortcut", "Wow![great] news"],
    ["full", "Grew revenue 40%![details][cat]"],
    ["collapsed", "Sold 3x![units][] last year"],
  ])("leaves an UNDEFINED %s reference as literal text", (_label, text) => {
    expect(stripReferenceImages(text, defs)).toBe(text);
  });

  it("does not claim a non-image reference of the same shape", () => {
    expect(stripReferenceImages("A [Company logo][logo] B", defs)).toBe(
      "A [Company logo][logo] B",
    );
  });

  it("assumes the INLINE image shape is already gone — an ordering contract", () => {
    // Pinning the contract, not endorsing the output: `![logo](url)` opens with
    // the same `![alt]` token, so handed one raw this leaves the bare `(url)`
    // behind. It never gets one — `markdown-lines.ts` runs `stripImages` (which
    // owns `![alt](url)`) before `flattenLinks` calls this. A future caller that
    // reorders the two would see the mess below rather than silence.
    expect(
      stripReferenceImages("A ![logo](https://example.org/x.png) B", defs),
    ).toBe("A (https://example.org/x.png) B");
  });

  it("is a no-op when the document defines nothing", () => {
    const text = "Wow![great] news and ![logo][]";
    expect(stripReferenceImages(text, new Map())).toBe(text);
  });
});

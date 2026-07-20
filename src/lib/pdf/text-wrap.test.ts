// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { wrapWordsToLines, type TextMeasurer } from "./text-wrap.ts";

/** Monospace-ish fake: every glyph is `size` wide, so width == chars * size. */
const mono: TextMeasurer = {
  widthOfTextAtSize: (text, size) => text.length * size,
};

// size 1 → width == character count, so maxWidth reads as "chars per line".
const SIZE = 1;

describe("wrapWordsToLines", () => {
  it("packs words greedily up to maxWidth", () => {
    // "aa bb cc" — maxWidth 5 fits "aa bb" (5) but not "+ cc".
    expect(wrapWordsToLines(["aa", "bb", "cc"], mono, SIZE, 5)).toEqual([
      "aa bb",
      "cc",
    ]);
  });

  it("emits an overlong word as its own line when NOT breaking (default)", () => {
    // The résumé renderer relies on this: never split a word/segment mid-word.
    expect(
      wrapWordsToLines(["short", "supercalifragilistic"], mono, SIZE, 6),
    ).toEqual(["short", "supercalifragilistic"]);
  });

  it("breaks a single overlong word at char boundaries when asked (#421 B#5)", () => {
    // A 15-char URL-like word, maxWidth 6 → chunks of ≤6 chars, none overflow.
    const lines = wrapWordsToLines(["abcdefghijklmno"], mono, SIZE, 6, true);
    expect(lines.join("")).toBe("abcdefghijklmno"); // lossless
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(6);
    expect(lines.length).toBeGreaterThan(1); // actually split
  });

  it("breaks an overlong word that follows a normal word", () => {
    const lines = wrapWordsToLines(["hi", "abcdefghij"], mono, SIZE, 4, true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toBe("hi");
    expect(lines.join(" ").replace(/ /g, "")).toContain("abcdefghij");
  });

  it("returns [] for no words", () => {
    expect(wrapWordsToLines([], mono, SIZE, 10)).toEqual([]);
  });
});

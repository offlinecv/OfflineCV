// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  MIDDOT,
  MIDDOT_JOIN,
  MIDDOT_SPLIT_RE,
  ORG_COMMA,
  HEADER_DATE_GAP,
  HEADER_WRAP_INDENT,
} from "./separators.ts";

/** Code points, so a look-alike substitution (U+2022 BULLET, U+00A0 NBSP,
 *  U+2013 EN DASH) fails here rather than silently in a rendered PDF. */
function codePoints(s: string): string[] {
  return [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
}

describe("separator bytes", () => {
  it("MIDDOT is U+00B7, not a bullet or a look-alike", () => {
    expect(codePoints(MIDDOT)).toEqual(["U+00B7"]);
  });

  it("MIDDOT_JOIN is ASCII-space-padded, never NBSP", () => {
    expect(MIDDOT_JOIN).toBe(" · ");
    expect(codePoints(MIDDOT_JOIN)).toEqual(["U+0020", "U+00B7", "U+0020"]);
  });

  it("ORG_COMMA is a comma plus one ASCII space", () => {
    expect(codePoints(ORG_COMMA)).toEqual(["U+002C", "U+0020"]);
  });

  it("HEADER_DATE_GAP is exactly two ASCII spaces", () => {
    expect(codePoints(HEADER_DATE_GAP)).toEqual(["U+0020", "U+0020"]);
  });

  it("HEADER_WRAP_INDENT is 12pt", () => {
    expect(HEADER_WRAP_INDENT).toBe(12);
  });
});

describe("MIDDOT_SPLIT_RE — the boundary the re-parser sees", () => {
  it("requires whitespace on both sides", () => {
    expect(MIDDOT_SPLIT_RE.test("Company · Location")).toBe(true);
    expect(MIDDOT_SPLIT_RE.test("Company·Location")).toBe(false);
    expect(MIDDOT_SPLIT_RE.test("Company ·Location")).toBe(false);
    expect(MIDDOT_SPLIT_RE.test("Company· Location")).toBe(false);
  });

  it("absorbs the NBSP / thin spaces a PDF extractor hands back", () => {
    expect("Company\u00a0·\u2009Location".split(MIDDOT_SPLIT_RE)).toEqual([
      "Company",
      "Location",
    ]);
  });

  it("splits what MIDDOT_JOIN composed", () => {
    expect(["a", "b", "c"].join(MIDDOT_JOIN).split(MIDDOT_SPLIT_RE)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is non-global, so repeated .test calls are stateless", () => {
    expect(MIDDOT_SPLIT_RE.global).toBe(false);
    expect(MIDDOT_SPLIT_RE.test("a · b")).toBe(true);
    expect(MIDDOT_SPLIT_RE.test("a · b")).toBe(true);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import {
  accumulatePhrases,
  buildPhraseBrief,
  extractStrongPhrase,
} from "./phrase-tracking.ts";

describe("extractStrongPhrase", () => {
  it("returns the first two content words after the leading verb", () => {
    expect(extractStrongPhrase("Built distributed systems for Foo")).toBe(
      "distributed systems",
    );
  });

  it("skips stopwords and assembles only consecutive content words", () => {
    // "led" + "the" (stopword, resets) + "team" + "of" (stopword, resets) +
    // "five" + "senior" — first valid 2-word run is "five senior".
    expect(extractStrongPhrase("Led the team of five senior engineers")).toBe(
      "five senior",
    );
  });

  it("strips a leading list marker before scanning", () => {
    expect(extractStrongPhrase("1. Shipped distributed systems")).toBe(
      "distributed systems",
    );
  });

  it("strips leading markdown bold before scanning", () => {
    expect(extractStrongPhrase("**Built** distributed systems")).toBe(
      "distributed systems",
    );
  });

  it("skips numeric-only tokens and currency tokens", () => {
    // "drove" + "$1.2M" (skipped) + "in" (stopword, resets) + "annual"
    // + "recurring" — first valid 2-word run is "annual recurring".
    expect(extractStrongPhrase("Drove $1.2M in annual recurring revenue")).toBe(
      "annual recurring",
    );
  });

  it("returns null when no two consecutive content words exist", () => {
    expect(extractStrongPhrase("Led")).toBeNull();
    expect(extractStrongPhrase("Led 5")).toBeNull();
    expect(extractStrongPhrase("Led the team")).toBeNull();
    expect(extractStrongPhrase("")).toBeNull();
  });

  it("lowercases the phrase regardless of input casing", () => {
    expect(extractStrongPhrase("Built Distributed Systems")).toBe(
      "distributed systems",
    );
  });
});

describe("buildPhraseBrief", () => {
  it("returns null for an empty phrase set", () => {
    expect(buildPhraseBrief(new Set())).toBeNull();
  });

  it("formats a single-line constraint sentence", () => {
    const brief = buildPhraseBrief(
      new Set(["distributed systems", "internal admin tool"]),
    );
    expect(brief).toContain("distributed systems");
    expect(brief).toContain("internal admin tool");
    expect(brief).toContain("Avoid repeating");
  });

  it("preserves insertion order (oldest first)", () => {
    const set = new Set<string>();
    set.add("alpha bravo");
    set.add("charlie delta");
    set.add("echo foxtrot");
    const brief = buildPhraseBrief(set);
    expect(brief).toMatch(/alpha bravo.*charlie delta.*echo foxtrot/);
  });

  it("caps the brief at the most recent 8 phrases", () => {
    const set = new Set<string>();
    for (let i = 0; i < 12; i++) set.add(`phrase ${i}`);
    const brief = buildPhraseBrief(set);
    // The first 4 are dropped (12 - 8 = 4); phrase 4 onwards survives.
    expect(brief).not.toContain("phrase 0;");
    expect(brief).not.toContain("phrase 3;");
    expect(brief).toContain("phrase 4");
    expect(brief).toContain("phrase 11");
  });
});

describe("accumulatePhrases", () => {
  it("adds each line's strong phrase to the set", () => {
    const set = new Set<string>();
    accumulatePhrases(
      ["Built distributed systems", "Owned internal admin tools"],
      set,
    );
    expect([...set]).toEqual(["distributed systems", "internal admin"]);
  });

  it("skips lines with no extractable phrase", () => {
    const set = new Set<string>();
    accumulatePhrases(["Built distributed systems", "Led 5", "Led the team"], set);
    expect([...set]).toEqual(["distributed systems"]);
  });

  it("floats a repeated phrase to the tail of the insertion-order Set", () => {
    const set = new Set<string>();
    set.add("distributed systems");
    set.add("admin tools");
    accumulatePhrases(["Built distributed systems"], set);
    // "distributed systems" moved to the tail; "admin tools" is now older.
    expect([...set]).toEqual(["admin tools", "distributed systems"]);
  });
});

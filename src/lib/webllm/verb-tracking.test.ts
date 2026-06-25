// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import {
  accumulateVerbs,
  buildVerbBrief,
  extractLeadingVerb,
} from "./verb-tracking.ts";

describe("extractLeadingVerb", () => {
  it("returns the lowercased first word of a plain bullet", () => {
    expect(extractLeadingVerb("Built a thing")).toBe("built");
  });

  it("preserves all-lowercase input", () => {
    expect(extractLeadingVerb("led a team")).toBe("led");
  });

  it("strips a numbered list marker before reading the first word", () => {
    expect(extractLeadingVerb("1. Shipped Foo")).toBe("shipped");
    expect(extractLeadingVerb("3) Drove revenue")).toBe("drove");
  });

  it("strips a bullet glyph before reading the first word", () => {
    expect(extractLeadingVerb("• Owned the migration")).toBe("owned");
    expect(extractLeadingVerb("- Built the thing")).toBe("built");
    expect(extractLeadingVerb("* Built the thing")).toBe("built");
  });

  it("strips leading markdown bold before reading the first word", () => {
    expect(extractLeadingVerb("**Built** a thing")).toBe("built");
  });

  it("strips a leading quote before reading the first word", () => {
    expect(extractLeadingVerb('"Shipped Foo"')).toBe("shipped");
  });

  it("returns null for an empty/whitespace-only line", () => {
    expect(extractLeadingVerb("")).toBeNull();
    expect(extractLeadingVerb("   ")).toBeNull();
  });

  it("returns null when the first token is purely numeric", () => {
    expect(extractLeadingVerb("$1.2M in ARR")).toBeNull();
    expect(extractLeadingVerb("100% of the team")).toBeNull();
  });

  it("returns null for single-letter tokens (too noisy)", () => {
    expect(extractLeadingVerb("X marked the spot")).toBeNull();
  });

  it("keeps hyphenated verbs intact", () => {
    expect(extractLeadingVerb("Co-led the team")).toBe("co-led");
  });
});

describe("buildVerbBrief", () => {
  it("returns null for an empty verb set", () => {
    expect(buildVerbBrief(new Set())).toBeNull();
  });

  it("formats a one-line constraint sentence", () => {
    const brief = buildVerbBrief(new Set(["built", "led"]));
    expect(brief).toContain("built");
    expect(brief).toContain("led");
    expect(brief).toContain("Choose different verbs");
  });

  it("preserves insertion order (oldest first)", () => {
    const set = new Set<string>();
    set.add("built");
    set.add("led");
    set.add("shipped");
    const brief = buildVerbBrief(set);
    expect(brief).toMatch(/built.*led.*shipped/);
  });

  it("caps the brief at the most recent 12 verbs", () => {
    const set = new Set<string>();
    for (let i = 0; i < 20; i++) set.add(`verb${i}`);
    const brief = buildVerbBrief(set);
    // The first 8 are dropped (20 - 12 = 8); verb8 onwards survives.
    expect(brief).not.toContain("verb0,");
    expect(brief).not.toContain("verb7,");
    expect(brief).toContain("verb8");
    expect(brief).toContain("verb19");
  });
});

describe("accumulateVerbs", () => {
  it("adds the leading verb of each line to the set", () => {
    const set = new Set<string>();
    accumulateVerbs(["Built X", "Led Y", "Shipped Z"], set);
    expect([...set]).toEqual(["built", "led", "shipped"]);
  });

  it("skips lines with no leading alphabetic token", () => {
    const set = new Set<string>();
    accumulateVerbs(["Built X", "$5K ARR", "Led Y"], set);
    expect([...set]).toEqual(["built", "led"]);
  });

  it("floats a repeated verb to the tail (so the cap surfaces fresh repeats)", () => {
    const set = new Set<string>();
    set.add("built");
    set.add("led");
    accumulateVerbs(["Built Z"], set);
    // built moved to the tail; led is now older
    expect([...set]).toEqual(["led", "built"]);
  });
});

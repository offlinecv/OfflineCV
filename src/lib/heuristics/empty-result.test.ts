// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import { buildBlankResult } from "./empty-result.ts";

describe("buildBlankResult", () => {
  it("returns empty parsed sections and no triggers", () => {
    const result = buildBlankResult();
    expect(result.canonical.fields).toEqual({
      skills: [],
      skills_explicit: [],
      skills_inferred: [],
      experience: [],
      education: [],
    });
    expect(result.triggers).toEqual([]);
    expect(result.linkAnnotations).toEqual([]);
  });

  it("never trips the fonts_unmappable / scanned degenerate branches", () => {
    const result = buildBlankResult();
    expect(result.triggers.includes("fonts_unmappable")).toBe(false);
    expect(result.triggers.includes("scanned")).toBe(false);
  });

  it("is authored, not parsed — suggestedEscalation is 'none' and tiers is empty", () => {
    const result = buildBlankResult();
    expect(result.suggestedEscalation).toBe("none");
    expect(result.tiers).toEqual([]);
  });

  it("carries an empty (but well-typed) section view", () => {
    const result = buildBlankResult();
    expect(result.canonical.sections.byName.size).toBe(0);
    expect(result.canonical.sections.accomplishmentSections).toEqual([
      "experience",
      "projects",
      "achievements",
    ]);
    expect(result.canonical.sections.source).toBe("regex");
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = buildBlankResult();
    const b = buildBlankResult();
    expect(a).not.toBe(b);
    expect(a.canonical.fields).not.toBe(b.canonical.fields);
    a.canonical.fields.skills.push("mutated");
    expect(b.canonical.fields.skills).toEqual([]);
  });
});

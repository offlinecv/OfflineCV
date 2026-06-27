// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { buildJdRewriteContext } from "./rewrite-context.ts";
import type { CoverageResult } from "./coverage.ts";
import type { ExtractedTerm } from "./extract-jd-terms.ts";

function term(display: string): ExtractedTerm {
  return { id: display.toLowerCase(), display, source: "skill", snippet: "" };
}

function coverage(missing: string[]): CoverageResult {
  return {
    covered: [],
    missing: missing.map(term),
    score: 0,
    weights: { skill: 1, noun: 0.5 },
  };
}

describe("buildJdRewriteContext (#226)", () => {
  it("returns null when nothing is missing (→ generic rewrite)", () => {
    expect(buildJdRewriteContext(coverage([]))).toBeNull();
  });

  it("names the missing terms in the instruction", () => {
    const out = buildJdRewriteContext(coverage(["Kubernetes", "GraphQL"]));
    expect(out).toContain("Kubernetes");
    expect(out).toContain("GraphQL");
  });

  it("carries the no-fabrication guardrail", () => {
    const out = buildJdRewriteContext(coverage(["Rust"]));
    expect(out).toMatch(/do not invent/i);
  });

  it("caps the number of named terms so the suffix stays short", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Skill${i}`);
    const out = buildJdRewriteContext(coverage(many))!;
    // Only the first 12 are named; the 13th onward are dropped.
    expect(out).toContain("Skill11");
    expect(out).not.toContain("Skill12");
  });

  it("ignores blank displays", () => {
    expect(buildJdRewriteContext(coverage(["   ", ""]))).toBeNull();
  });
});

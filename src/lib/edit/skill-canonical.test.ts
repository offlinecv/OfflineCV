// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { canonicalizeSkill, suggestSkills } from "./skill-canonical.ts";

describe("canonicalizeSkill", () => {
  it("folds known aliases to canonical display form", () => {
    expect(canonicalizeSkill("js")).toBe("JavaScript");
    expect(canonicalizeSkill("ReactJS")).toBe("React");
    expect(canonicalizeSkill("react.js")).toBe("React");
    expect(canonicalizeSkill("postgres")).toBe("PostgreSQL");
    expect(canonicalizeSkill("k8s")).toBe("Kubernetes");
  });

  it("matches a canonical entry case-insensitively, returning canonical casing", () => {
    expect(canonicalizeSkill("typescript")).toBe("TypeScript");
    expect(canonicalizeSkill("PYTHON")).toBe("Python");
  });

  it("collapses internal whitespace on alias keys", () => {
    expect(canonicalizeSkill("  react   js ")).toBe("React");
    expect(canonicalizeSkill("node js")).toBe("Node.js");
  });

  it("keeps an unknown skill verbatim (trimmed, whitespace-collapsed)", () => {
    expect(canonicalizeSkill("  Embedded   Systems ")).toBe("Embedded Systems");
    expect(canonicalizeSkill("COBOL")).toBe("COBOL");
  });

  it("returns empty string for blank input", () => {
    expect(canonicalizeSkill("")).toBe("");
    expect(canonicalizeSkill("   ")).toBe("");
  });
});

describe("suggestSkills", () => {
  it("returns prefix matches before substring matches", () => {
    const out = suggestSkills("type", []);
    expect(out[0]).toBe("TypeScript");
  });

  it("excludes skills already present (case-insensitive)", () => {
    const out = suggestSkills("type", ["typescript"]);
    expect(out).not.toContain("TypeScript");
  });

  it("returns nothing for a blank query", () => {
    expect(suggestSkills("", ["React"])).toEqual([]);
    expect(suggestSkills("   ", ["React"])).toEqual([]);
  });

  it("respects the limit", () => {
    const out = suggestSkills("a", [], 3);
    expect(out.length).toBeLessThanOrEqual(3);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { parseFixture, REWRITE_FIXTURES, getFixtureById } from "./fixtures.ts";

describe("REWRITE_FIXTURES", () => {
  it("loads exactly the four canonical fixture kinds", () => {
    const kinds = REWRITE_FIXTURES.map((f) => f.kind).sort();
    expect(kinds).toEqual(["numeric", "redundant", "strong", "weak"]);
  });

  it("every fixture has a non-empty id, description, and bullets", () => {
    for (const f of REWRITE_FIXTURES) {
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.bullets.length).toBeGreaterThan(0);
      for (const b of f.bullets) expect(b.length).toBeGreaterThan(0);
    }
  });

  it("fixture ids are unique", () => {
    const ids = REWRITE_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getFixtureById finds known ids and misses unknown ones", () => {
    expect(getFixtureById(REWRITE_FIXTURES[0].id)).toBeDefined();
    expect(getFixtureById("nope")).toBeUndefined();
  });
});

describe("parseFixture", () => {
  it("rejects a fixture missing an id", () => {
    expect(() =>
      parseFixture(
        { kind: "weak", description: "x", bullets: ["a"] },
        "test.json",
      ),
    ).toThrow(/missing\/empty 'id'/);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      parseFixture(
        { id: "x", kind: "bogus", description: "x", bullets: ["a"] },
        "test.json",
      ),
    ).toThrow(/'kind' must be one of/);
  });

  it("rejects an empty bullets array", () => {
    expect(() =>
      parseFixture(
        { id: "x", kind: "weak", description: "x", bullets: [] },
        "test.json",
      ),
    ).toThrow(/non-empty string/);
  });
});

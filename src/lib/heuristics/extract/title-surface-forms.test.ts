// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for the `title-surface-forms.ts` leaf (#918, part (d) of #653):
 *
 *   - both it and `title-shape.ts` actually keep their "imports nothing"
 *     contract (neither had a test pinning that before this issue);
 *   - `title-shape.ts`'s `TITLE_KEYWORDS` is a real subset of this leaf's
 *     `TITLE_SURFACE_FORMS` — the other half of the join lives in
 *     `job-search/role-profiles.test.ts`, which asserts every title that
 *     table curates is covered by this same leaf.
 *
 * Same "imports nothing" check as `bullet-glyphs.test.ts` (#915) — rejects any
 * statement that creates a module edge (`import`, a re-export `from "…"`, or a
 * dynamic `import(…)`), not just the literal word "import" in a comment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TITLE_KEYWORDS } from "./title-shape.ts";
import { TITLE_SURFACE_FORMS } from "./title-surface-forms.ts";

function importEdgeStatements(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return code
    .split("\n")
    .filter((line) => /^\s*import\b|\bfrom\s+["']|\bimport\s*\(/.test(line));
}

describe("title-shape leaf contract", () => {
  it("imports nothing (#918)", () => {
    const path = fileURLToPath(new URL("./title-shape.ts", import.meta.url));
    expect(importEdgeStatements(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(TITLE_KEYWORDS).size).toBe(TITLE_KEYWORDS.length);
  });
});

describe("title-surface-forms leaf contract", () => {
  it("imports nothing", () => {
    const path = fileURLToPath(new URL("./title-surface-forms.ts", import.meta.url));
    expect(importEdgeStatements(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(TITLE_SURFACE_FORMS).size).toBe(TITLE_SURFACE_FORMS.length);
  });

  // The join: the leaf's first TITLE_KEYWORDS.length entries are
  // title-shape.ts's TITLE_KEYWORDS, byte-identical and in the same order
  // (the leaf's own docblock's claim, pinned here rather than by a loose
  // `toContain` loop, which would pass even if an entry were reordered,
  // dropped-and-replaced, or misspelled so long as every OTHER keyword was
  // still present somewhere in the leaf). title-shape.ts is NOT changed to
  // import the leaf (it keeps its own "imports nothing" contract) — this is
  // what keeps the two assets joinable without either importing the other.
  it("has title-shape.ts's TITLE_KEYWORDS as its leading entries, verbatim", () => {
    expect(TITLE_SURFACE_FORMS.slice(0, TITLE_KEYWORDS.length)).toEqual([...TITLE_KEYWORDS]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AMBIGUOUS_DASH_BULLETS,
  bulletCharClass,
  EM_DASH_BULLET,
  HYPHEN_BULLET_GLYPH,
  LONE_LINE_BULLET_GLYPHS,
  MARKDOWN_BULLET_GLYPHS,
  PARSER_BULLET_GLYPHS,
  SCORER_BULLET_GLYPHS,
} from "./bullet-glyphs.ts";

const SOURCE_PATH = fileURLToPath(new URL("./bullet-glyphs.ts", import.meta.url));

describe("bullet-glyphs leaf contract", () => {
  it("imports nothing — the whole point of pulling this out of line-primitives.ts (#915)", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    // A doc comment is allowed to say the word "import"; what this test rejects
    // is any statement that creates a module edge: an `import` declaration, a
    // re-export (`export { x } from "…"`), or a dynamic `import(…)` — each of
    // which would drag its target onto every consumer of this leaf.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const edgeStatements = code
      .split("\n")
      .filter((line) => /^\s*import\b|\bfrom\s+["']|\bimport\s*\(/.test(line));
    expect(edgeStatements).toEqual([]);
  });
});

describe("bulletCharClass", () => {
  it("builds a character class that matches every glyph in the set, nothing else", () => {
    const re = new RegExp(bulletCharClass(["a", "-", "]", "^"]));
    expect(re.test("a")).toBe(true);
    expect(re.test("-")).toBe(true);
    expect(re.test("]")).toBe(true);
    expect(re.test("^")).toBe(true);
    expect(re.test("b")).toBe(false);
  });
});

describe("#915 per-glyph adjudication", () => {
  it("the scorer adopts the hyphen-bullet (U+2043) and em dash the parser already treated as bullets", () => {
    expect(PARSER_BULLET_GLYPHS).toContain(HYPHEN_BULLET_GLYPH);
    expect(PARSER_BULLET_GLYPHS).toContain(EM_DASH_BULLET);
    expect(SCORER_BULLET_GLYPHS).toContain(HYPHEN_BULLET_GLYPH);
    expect(SCORER_BULLET_GLYPHS).toContain(EM_DASH_BULLET);
  });

  it("the scorer does not lose any glyph it recognised before #915", () => {
    // The scorer-only pointer/middot/undecoded glyphs, spelled out here as
    // codepoints rather than the leaf's own names, so this test fails if the
    // leaf's composition ever silently drops one.
    for (const glyph of ["▶", "►", "·", "�", ""]) {
      expect(SCORER_BULLET_GLYPHS).toContain(glyph);
    }
  });

  it("the parser's bullet class is a subset of the scorer's (#915 union, not a swap)", () => {
    for (const glyph of PARSER_BULLET_GLYPHS) {
      expect(SCORER_BULLET_GLYPHS).toContain(glyph);
    }
  });

  it("the ambiguous dash pair (-, en dash, #821) is named once and stays in both classes unchanged", () => {
    expect(AMBIGUOUS_DASH_BULLETS).toEqual(["-", "–"]);
    for (const glyph of AMBIGUOUS_DASH_BULLETS) {
      expect(PARSER_BULLET_GLYPHS).toContain(glyph);
      expect(SCORER_BULLET_GLYPHS).toContain(glyph);
    }
  });

  it("markdown-emit's glyph set is untouched by the #915 parser/scorer union", () => {
    // markdown-emit recognises `▸`/`⬤`/`∙`, which neither the parser nor the
    // scorer ever have — and it does NOT gain `—` (em dash), which #915 only
    // moves between the parser and the scorer.
    expect(MARKDOWN_BULLET_GLYPHS).toContain("▸");
    expect(MARKDOWN_BULLET_GLYPHS).not.toContain(EM_DASH_BULLET);
  });

  it("the lone-line glyph set stays dash-free (score.ts LONE_BULLET_RE, unchanged by #915)", () => {
    for (const dash of [...AMBIGUOUS_DASH_BULLETS, HYPHEN_BULLET_GLYPH, EM_DASH_BULLET, "*"]) {
      expect(LONE_LINE_BULLET_GLYPHS).not.toContain(dash);
    }
  });
});

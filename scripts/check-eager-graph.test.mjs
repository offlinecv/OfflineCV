// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the eager-graph static-import scanner (#1106). Each test
 * builds a tiny synthetic module tree under `mkdtemp` rather than pointing at
 * the real repo, so the four shapes the scanner has to get right — type-only
 * ignored, dynamic ignored, re-export counted, chain naming — are pinned
 * independently of anything `src/` happens to look like on a given day.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractStaticImportSpecifiers, shortestChain, staticClosure } from "./check-eager-graph.mjs";

let dir;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Write a synthetic module tree under a fresh temp dir; returns the dir. */
function makeTree(files) {
  dir = mkdtempSync(join(tmpdir(), "eager-graph-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("extractStaticImportSpecifiers", () => {
  it("ignores an `import type` statement", () => {
    const specs = extractStaticImportSpecifiers(
      `import type { X } from "./target.ts";\nexport const a = 1;\n`,
    );
    expect(specs).not.toContain("./target.ts");
  });

  it("ignores an `export type … from` re-export", () => {
    const specs = extractStaticImportSpecifiers(`export type { X } from "./target.ts";\n`);
    expect(specs).not.toContain("./target.ts");
  });

  it("ignores a dynamic import()", () => {
    const specs = extractStaticImportSpecifiers(
      `export async function load() {\n  return import("./target.ts");\n}\n`,
    );
    expect(specs).not.toContain("./target.ts");
  });

  it("counts a value `import … from`", () => {
    const specs = extractStaticImportSpecifiers(`import { x } from "./target.ts";\n`);
    expect(specs).toContain("./target.ts");
  });

  it("counts an `export … from` re-export", () => {
    const specs = extractStaticImportSpecifiers(`export { x } from "./target.ts";\n`);
    expect(specs).toContain("./target.ts");
  });

  it("counts a bare side-effect import", () => {
    const specs = extractStaticImportSpecifiers(`import "./target.ts";\n`);
    expect(specs).toContain("./target.ts");
  });
});

describe("staticClosure", () => {
  it("excludes a module reached only through a type-only import", () => {
    makeTree({
      "entry.ts": `import type { X } from "./target.ts";\nexport const a = 1;\n`,
      "target.ts": `export type X = string;\n`,
    });
    const closure = staticClosure(join(dir, "entry.ts"));
    expect([...closure].some((f) => f.endsWith("target.ts"))).toBe(false);
  });

  it("excludes a module reached only through a dynamic import()", () => {
    makeTree({
      "entry.ts": `export async function load() {\n  return import("./target.ts");\n}\n`,
      "target.ts": `export const y = 1;\n`,
    });
    const closure = staticClosure(join(dir, "entry.ts"));
    expect([...closure].some((f) => f.endsWith("target.ts"))).toBe(false);
  });

  it("includes a module reached through a re-export", () => {
    makeTree({
      "entry.ts": `export { z } from "./target.ts";\n`,
      "target.ts": `export const z = 1;\n`,
    });
    const closure = staticClosure(join(dir, "entry.ts"));
    expect([...closure].some((f) => f.endsWith("target.ts"))).toBe(true);
  });

  it("does not walk into an external (non-relative) package", () => {
    makeTree({ "entry.ts": `import { useState } from "react";\nexport const a = useState;\n` });
    const closure = staticClosure(join(dir, "entry.ts"));
    expect(closure.size).toBe(1);
  });
});

describe("shortestChain", () => {
  it("names the shortest chain to a module nested behind an intermediate", () => {
    makeTree({
      "entry.ts": `import { mid } from "./mid.ts";\nexport { mid };\n`,
      "mid.ts": `export { target } from "./target.ts";\n`,
      "target.ts": `export const target = 1;\n`,
    });
    const chain = shortestChain(join(dir, "entry.ts"), "target.ts");
    expect(chain?.map((f) => f.split("/").pop())).toEqual(["entry.ts", "mid.ts", "target.ts"]);
  });

  it("returns null when the target is unreachable", () => {
    makeTree({
      "entry.ts": `export const a = 1;\n`,
      "target.ts": `export const target = 1;\n`,
    });
    expect(shortestChain(join(dir, "entry.ts"), "target.ts")).toBeNull();
  });

  it("does not chain through a dynamic import()", () => {
    makeTree({
      "entry.ts": `export async function load() {\n  return import("./target.ts");\n}\n`,
      "target.ts": `export const target = 1;\n`,
    });
    expect(shortestChain(join(dir, "entry.ts"), "target.ts")).toBeNull();
  });

  it("prefers the shorter of two paths to the same target", () => {
    makeTree({
      "entry.ts": `import "./long.ts";\nimport { target } from "./target.ts";\nexport { target };\n`,
      "long.ts": `export { target } from "./target.ts";\n`,
      "target.ts": `export const target = 1;\n`,
    });
    const chain = shortestChain(join(dir, "entry.ts"), "target.ts");
    expect(chain?.map((f) => f.split("/").pop())).toEqual(["entry.ts", "target.ts"]);
  });
});

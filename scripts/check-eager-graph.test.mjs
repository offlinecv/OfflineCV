// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the eager-graph gate (#1106).
 *
 * The load-bearing cases are the ones where the walk must NOT count an edge —
 * a type-only import and a dynamic `import()` — because a gate that counted
 * them would flag the very mechanisms that keep a module off the eager graph,
 * and the fix for a violation would then be to delete the gate. Fixtures are a
 * synthetic tree under `mkdtemp`, so the test never depends on the real
 * `src/` layout; the repo-level run is `node scripts/check-eager-graph.mjs`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  chainTo,
  entryFromHtml,
  parseStaticImports,
  resolveSpecifier,
  staticClosure,
  violations,
} from "./check-eager-graph.mjs";

let root;
function write(rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "eager-graph-"));
  write("index.html", '<!doctype html><script type="module" src="/src/main.tsx"></script>');
  write("src/main.tsx", 'import { App } from "./App.tsx";\nimport "./styles.css";\nApp();\n');
  write("src/styles.css", "");
  write(
    "src/App.tsx",
    [
      'import type { Heavy } from "./lib/heavy.ts";',
      'export { leaf } from "./lib/leaf.ts";',
      "export async function App(): Promise<Heavy> {",
      '  const { heavy } = await import("./lib/heavy.ts");',
      "  return heavy();",
      "}",
    ].join("\n"),
  );
  write("src/lib/leaf.ts", 'import { deep } from "./deep/index.ts";\nexport const leaf = deep;\n');
  write("src/lib/deep/index.ts", "export const deep = 1;\n");
  write("src/lib/heavy.ts", "export type Heavy = number;\nexport function heavy(): Heavy { return 2; }\n");
  write("src/lib/bridge.js", 'import { heavy } from "./heavy.ts";\nexport const viaBridge = heavy;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseStaticImports", () => {
  it("counts import-from, export-from and side-effect imports", () => {
    expect(
      parseStaticImports('import { a } from "./a.ts";\nexport { b } from "./b.ts";\nimport "./c.css";\n'),
    ).toEqual(["./a.ts", "./b.ts", "./c.css"]);
  });

  it("ignores type-only imports and dynamic import()", () => {
    expect(
      parseStaticImports(
        'import type { T } from "./t.ts";\nexport type { U } from "./u.ts";\nconst m = await import("./d.ts");\n',
      ),
    ).toEqual([]);
  });

  it("ignores a specifier that only appears in a comment", () => {
    expect(parseStaticImports('// import { x } from "./x.ts";\n/* export { y } from "./y.ts"; */\n')).toEqual([]);
  });

  it("handles a multi-line import list", () => {
    expect(parseStaticImports('import {\n  a,\n  b,\n} from "./ab.ts";\n')).toEqual(["./ab.ts"]);
  });

  it("reads every statement on a shared physical line, not just the first", () => {
    expect(parseStaticImports('import { a } from "./a.ts"; import { b } from "./entry-blocks.ts";\n')).toEqual([
      "./a.ts",
      "./entry-blocks.ts",
    ]);
  });

  it("treats an import whose every binding is type-marked as elided, but a mixed one as an edge", () => {
    expect(parseStaticImports('import { type A, type B } from "./t.ts";\n')).toEqual([]);
    expect(parseStaticImports('import { type A, b } from "./ab.ts";\n')).toEqual(["./ab.ts"]);
    expect(parseStaticImports('export { type A, b } from "./ab.ts";\n')).toEqual(["./ab.ts"]);
  });

  it("parses JSX/TSX and plain JS dialects", () => {
    expect(parseStaticImports('import { X } from "./x.tsx";\nexport const El = () => <X />;\n', "a.tsx")).toEqual(["./x.tsx"]);
    expect(parseStaticImports('import { y } from "./y.js";\nexport const z = y;\n', "b.mjs")).toEqual(["./y.js"]);
  });
});

describe("resolveSpecifier", () => {
  it("resolves an explicit .ts path, an extensionless path and a directory index", () => {
    const from = join(root, "src/lib/leaf.ts");
    expect(resolveSpecifier(from, "./deep/index.ts", root)).toBe(join(root, "src/lib/deep/index.ts"));
    expect(resolveSpecifier(from, "./deep", root)).toBe(join(root, "src/lib/deep/index.ts"));
    expect(resolveSpecifier(from, "./heavy", root)).toBe(join(root, "src/lib/heavy.ts"));
  });

  it("does not walk bare package specifiers", () => {
    expect(resolveSpecifier(join(root, "src/main.tsx"), "react", root)).toBeNull();
  });

  it("resolves an extensionless specifier to a .js file, as Vite does", () => {
    expect(resolveSpecifier(join(root, "src/main.tsx"), "./lib/bridge", root)).toBe(join(root, "src/lib/bridge.js"));
  });
});

describe("staticClosure / chainTo / violations", () => {
  it("reads the entry script off the HTML", () => {
    expect(entryFromHtml(join(root, "index.html"), root)).toBe(join(root, "src/main.tsx"));
  });

  it("reaches re-exported modules but not type-only or dynamically imported ones", () => {
    const closure = staticClosure(join(root, "src/main.tsx"), root);
    expect(closure.has(join(root, "src/lib/deep/index.ts"))).toBe(true);
    expect(closure.has(join(root, "src/lib/heavy.ts"))).toBe(false);
  });

  it("names the shortest chain to a reached module", () => {
    const closure = staticClosure(join(root, "src/main.tsx"), root);
    expect(chainTo(closure, join(root, "src/lib/deep/index.ts"), root)).toEqual([
      "src/main.tsx",
      "src/App.tsx",
      "src/lib/leaf.ts",
      "src/lib/deep/index.ts",
    ]);
    expect(chainTo(closure, join(root, "src/lib/heavy.ts"), root)).toBeNull();
  });

  it("reports only forbidden modules the entry statically reaches, by path or directory prefix", () => {
    const entry = join(root, "src/main.tsx");
    expect(violations(entry, ["src/lib/heavy.ts"], root)).toEqual([]);
    expect(violations(entry, ["src/lib/deep/"], root)).toEqual([
      {
        module: "src/lib/deep/index.ts",
        chain: ["src/main.tsx", "src/App.tsx", "src/lib/leaf.ts", "src/lib/deep/index.ts"],
      },
    ]);
  });

  it("fails once a static edge to a forbidden module is added, through a .js bridge", () => {
    // `./lib/bridge` is extensionless and lands on `bridge.js`, which imports
    // the forbidden module — the edge the old .ts-only resolver would have dropped.
    write("src/App.tsx", 'import { viaBridge } from "./lib/bridge";\nexport const App = viaBridge;\n');
    const found = violations(join(root, "src/main.tsx"), ["src/lib/heavy.ts"], root);
    expect(found).toEqual([
      { module: "src/lib/heavy.ts", chain: ["src/main.tsx", "src/App.tsx", "src/lib/bridge.js", "src/lib/heavy.ts"] },
    ]);
  });

  it("reports the SHORTEST chain when the forbidden module is reachable by two paths", () => {
    // Long path: main → App → bridge.js → heavy (from the case above).
    // Short path: main → heavy, added here. The diagnostic must name the short one.
    write("src/main.tsx", 'import { App } from "./App.tsx";\nimport { heavy } from "./lib/heavy.ts";\nApp(); heavy();\n');
    const found = violations(join(root, "src/main.tsx"), ["src/lib/heavy.ts"], root);
    expect(found.map((v) => v.chain)).toEqual([["src/main.tsx", "src/lib/heavy.ts"]]);
  });
});

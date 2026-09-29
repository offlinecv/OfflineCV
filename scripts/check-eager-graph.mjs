// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Eager-entry-chunk gate (#1106, closing epic #646 item 3). Fails the build
 * when either HTML entry's STATIC import closure reaches a parser module that
 * is supposed to live behind a dynamic `import()` — the class of regression
 * #650 set out to fix and #1092 found unmet on `main`: the win from moving the
 * line assembler out of `sections.ts` doesn't hold if something else still
 * statically reaches it, and nothing was checking that until now.
 *
 * WHAT IT WALKS. `staticClosure(entryFile)` starts from the `<script
 * type="module" src>` of an HTML entry and follows every STATIC value edge
 * (`import … from "…"`, `export … from "…"`, a side-effect `import "…"`)
 * transitively — skipping `import type` / `export type` (erased at build time,
 * so they carry no bytes into the bundle) and skipping `import(...)` (a dynamic
 * import is exactly the seam #650 relies on: it puts the imported module in its
 * OWN chunk, loaded only when actually called). Non-relative specifiers (npm
 * packages) are treated as leaves — none of `FORBIDDEN_FILES` lives in
 * `node_modules`, so there is nothing to gain by resolving into it, and doing
 * so would mean shipping a resolver for every package's own `exports` map.
 * `@design-system` is the one bare specifier this repo's own code uses; it is
 * resolved the same way `tsconfig.app.json`'s `paths` and `vite.config.ts`'s
 * `resolve.alias` do, to `src/design-system/index.ts` — hardcoded here rather
 * than parsed out of either config, because this script runs under plain
 * `node`, with no TypeScript or Vite config loader available to it.
 *
 * WHY A REGEX SCANNER AND NOT A REAL PARSER. Every other build-time gate in
 * this repo (`check:nul`, `check:fixtures`, `check:core`) reads bytes or shells
 * out; none of them type-checks or ASTs the tree, and pulling in a TS parser
 * just for this gate would make it slower than the build step it is supposed
 * to run ahead of (~50ms today). The trade is real: a comment that happens to
 * contain the literal token `from "…"` before a statement's real one, or a
 * semicolon buried in a same-line comment, can confuse the scanner. Nothing in
 * this tree writes imports that way — Prettier lays out every import/export as
 * its own statement with nothing else on the line — and `check-eager-graph.test.mjs`
 * pins the four shapes that matter (type-only ignored, dynamic ignored,
 * re-export counted, chain naming) rather than claiming full-language coverage.
 *
 * WHAT COUNTS AS FORBIDDEN. `FORBIDDEN_FILES` names the modules #650 / #1106
 * moved (or found already moved) off the eager graph: `line-assembly.ts`,
 * `entry-blocks.ts`, `markdown-emit.ts`, `sections.ts`, `openresume.ts`,
 * `pdf-extract.ts`, `extract/achievements.ts`, `extract/projects.ts`.
 * `regex.ts` and `line-primitives.ts` are deliberately NOT on this list — both
 * stay eager through other edges #1106 left alone (`lib/edit/field-validators.ts`
 * and the exporter's `isLoneDateRange`, respectively).
 *
 * NOT ON THIS LIST, though they are also under `heuristics/extract/`:
 * `education-grade.ts` (a DIRECT `ats-resume-model.ts` import, `formatGradeNote`,
 * that #1106's plan never named), `corporate-suffix.ts` (pulled in by the
 * accepted-eager `line-primitives.ts` itself), and `work-authorization.ts` /
 * `title-shape.ts` (reached from `disagreement.ts` / `job-search/query-builder.ts`,
 * paths this issue never touches). Building this gate surfaced all four as
 * real, PRE-EXISTING static edges into `extract/` — i.e. the epic's "nothing
 * under extract/ is eager" aspiration does not hold today even after #1106 — but
 * fixing them is a separate, unscoped change apiece (an extractor split for
 * `education-grade.ts`'s exporter-used formatter, mirroring #1106 step 3; two
 * call sites that would need their own narrow leaf module for
 * `corporate-suffix.ts`; and two more for the disagreement/query-builder pair).
 * Widening `FORBIDDEN_FILES` to any of them without doing that work first would
 * ship a gate that fails on the commit that adds it. Tracked for follow-up
 * rather than silently ignored — see the #1106 PR description for the four
 * chains this gate printed when the walk first ran.
 *
 * Run:  node scripts/check-eager-graph.mjs
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The two production HTML entries (`vite.config.ts`'s `rollupOptions.input`,
 *  sourced from `HTML_ENTRIES` in `scripts/seo-artifacts.ts`). Repeated here
 *  rather than imported from that `.ts` module because this script runs under
 *  plain `node`, which has no loader for it — keep the two lists in sync by
 *  hand if a third entry is ever added. */
const ENTRY_HTML_FILES = ["index.html", "jobs/index.html"];

/** Parser modules #650 / #1106 moved off the eager graph. Exact repo-relative
 *  paths, POSIX-separated. See the module docblock for what is deliberately
 *  NOT here yet. */
const FORBIDDEN_FILES = [
  "src/lib/heuristics/line-assembly.ts",
  "src/lib/heuristics/entry-blocks.ts",
  "src/lib/heuristics/markdown-emit.ts",
  "src/lib/heuristics/sections.ts",
  "src/lib/heuristics/openresume.ts",
  "src/lib/heuristics/pdf-extract.ts",
  "src/lib/heuristics/extract/achievements.ts",
  "src/lib/heuristics/extract/projects.ts",
];

/** Whole directories that are forbidden on the eager graph, matched by
 *  repo-relative prefix. Empty today (see the docblock's "NOT ON THIS LIST"
 *  paragraph) — kept as its own list, rather than folded into
 *  `FORBIDDEN_FILES`, so a future PR that finishes decoupling the rest of
 *  `heuristics/extract/` can widen to the whole directory in one line. */
const FORBIDDEN_DIRS = [];

/** The alias `tsconfig.app.json` and `vite.config.ts` both wire up — the one
 *  bare specifier this repo's own source uses (import rule: "never deep
 *  paths"). Only the bare form resolves; there is no subpath mapping to mirror. */
const DESIGN_SYSTEM_ALIAS_TARGET = "src/design-system/index.ts";

// ── Static-import scanning ──────────────────────────────────────────────────
//
// Three passes over the raw source, each independent (not consuming each
// other's matches): a type-only `import`/`export … from` skips its capture,
// a value `import`/`export … from` counts it, and a bare side-effect
// `import "…"` counts it. `import(...)` never matches any of the three
// (`import\s+` requires whitespace before what follows; `import(` has none).

const VALUE_IMPORT_FROM_RE = /^[ \t]*import\s+(?!type\s)[\s\S]*?\bfrom\s*["']([^"']+)["']/gm;
const VALUE_EXPORT_FROM_RE = /^[ \t]*export\s+(?!type\s)[\s\S]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;

/** Every STATIC value-import specifier a source file names — see the module
 *  docblock for what "static" and "value" exclude. */
export function extractStaticImportSpecifiers(source) {
  const specifiers = [];
  for (const re of [VALUE_IMPORT_FROM_RE, VALUE_EXPORT_FROM_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specifiers.push(m[1]);
  }
  return specifiers;
}

/** Resolve an import specifier from `fromFile` to an absolute path, or `null`
 *  when it is an external package (nothing to walk into) or resolves to
 *  nothing on disk. Tries the bare path first (this repo's TS imports spell
 *  their own extension, e.g. `"./cascade.ts"`), then `index.ts(x)` for a
 *  directory specifier. */
function resolveSpecifier(fromFile, specifier) {
  let base;
  if (specifier === "@design-system") {
    base = join(REPO_ROOT, DESIGN_SYSTEM_ALIAS_TARGET);
  } else if (specifier.startsWith("/")) {
    base = join(REPO_ROOT, specifier.slice(1));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null; // external package — no forbidden module lives there
  }
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** BFS over the static-import graph from `entryFile`, following only edges
 *  that resolve to a `.ts`/`.tsx` file on disk (a `.css`/`.json` leaf has
 *  nothing further to scan, and cannot itself be a forbidden module). Returns
 *  the set of every `.ts`/`.tsx` file reached, entry included. */
export function staticClosure(entryFile) {
  const start = resolve(entryFile);
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    const source = readFileSync(file, "utf8");
    for (const specifier of extractStaticImportSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved || !/\.tsx?$/.test(resolved) || visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push(resolved);
    }
  }
  return visited;
}

/** BFS from `entryFile` for the SHORTEST static-import chain to a file whose
 *  resolved absolute path ends with `target` (a repo-relative suffix, e.g.
 *  `"src/lib/heuristics/line-assembly.ts"`, or just a filename). Returns the
 *  chain as an array of absolute paths from `entryFile` to the target
 *  (inclusive), or `null` if `target` is unreached. */
export function shortestChain(entryFile, target) {
  const start = resolve(entryFile);
  if (start.endsWith(target)) return [start];
  const parent = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    const source = readFileSync(file, "utf8");
    for (const specifier of extractStaticImportSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved || !/\.tsx?$/.test(resolved) || parent.has(resolved)) continue;
      parent.set(resolved, file);
      if (resolved.endsWith(target)) {
        const chain = [];
        for (let cur = resolved; cur !== null; cur = parent.get(cur)) chain.unshift(cur);
        return chain;
      }
      queue.push(resolved);
    }
  }
  return null;
}

/** The forbidden module `file` matches, or `undefined`. Repo-relative,
 *  POSIX-separated comparison so it is platform-independent. */
function forbiddenMatch(file) {
  const rel = relative(REPO_ROOT, file).split("\\").join("/");
  if (FORBIDDEN_FILES.includes(rel)) return rel;
  const dir = FORBIDDEN_DIRS.find((d) => rel.startsWith(d));
  return dir ? rel : undefined;
}

/** The entry module's resolved absolute path for one HTML entry, or throws if
 *  the entry has no `<script type="module" src>` — a malformed entry should
 *  fail loudly rather than silently check nothing. */
function entryModuleFor(htmlFile) {
  const html = readFileSync(join(REPO_ROOT, htmlFile), "utf8");
  const m =
    /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/i.exec(html) ??
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["'][^>]*>/i.exec(html);
  if (!m) throw new Error(`${htmlFile}: no <script type="module" src="…"> found`);
  const src = m[1];
  return { src, file: resolveSpecifier(join(REPO_ROOT, htmlFile), src) ?? join(REPO_ROOT, src.replace(/^\//, "")) };
}

function main() {
  let failed = false;
  for (const htmlFile of ENTRY_HTML_FILES) {
    const { src, file: entryFile } = entryModuleFor(htmlFile);
    const closure = staticClosure(entryFile);
    const hits = [...closure].map(forbiddenMatch).filter((rel) => rel !== undefined);

    if (hits.length === 0) {
      console.log(`✓ ${htmlFile} (${src}): static closure of ${closure.size} files reaches none of the forbidden modules`);
      continue;
    }

    failed = true;
    console.error(`✗ ${htmlFile} (${src}): static closure reaches ${hits.length} forbidden module(s):`);
    for (const rel of hits) {
      const chain = shortestChain(entryFile, rel);
      const shown = (chain ?? [entryFile, join(REPO_ROOT, rel)]).map((f) => relative(REPO_ROOT, f));
      console.error(`  - ${rel}`);
      console.error(`    ${shown.join(" → ")}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

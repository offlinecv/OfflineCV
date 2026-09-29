// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Eager-graph gate (#1106): no HTML entry may STATICALLY reach a parser module
 * that is meant to load on demand.
 *
 * `cascade.ts` dynamic-imports each tier so the entry chunk stays small, and
 * #650 moved the line assembler out of `sections.ts` for the same reason. Both
 * are conventions a single `import { x } from "…"` can undo without anything
 * failing — the app still works, the bundle is just bigger, and the only place
 * it shows is a chunk-size warning nobody reads. That is what happened between
 * #650 and #1106: the heuristics barrel re-exported the markdown emitter and
 * the PDF exporter imported one predicate from the entry-block segmenter, and
 * both entries loaded `line-assembly.ts` (and 1,900 lines of `entry-blocks.ts`)
 * before the user had dropped a file.
 *
 * The check is a source-level walk, not a bundle inspection, on purpose: the
 * invariant is about import EDGES, it runs in well under a second with no
 * build, and the failure names the exact chain to cut. Edges come from
 * TypeScript's own parser (`ts.createSourceFile`), not a regex, so two
 * statements on one physical line, a specifier quoted in a comment, and the
 * inline `import { type A }` form are all read the way the bundler reads them:
 * `import … from`, `export … from` and side-effect `import "…"` are edges;
 * `import type`, `export type`, an import whose every binding is `type`-marked
 * (elided by TS, so never emitted) and dynamic `import()` are not. Relative
 * specifiers resolve in Vite's default `resolve.extensions` order (`.mjs .js
 * .mts .ts .jsx .tsx .json`, then a directory index in the same order); the
 * aliases `vite.config.ts`'s `resolve.alias` defines resolve too (see
 * `ALIAS_TARGETS` below); bare package specifiers are not walked.
 *
 * Exit 0 when clean; exit 1 listing every forbidden module reached, with the
 * shortest chain from the entry. Exit 2 on a usage/environment error.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * Runs `fn` for its side effect at module-evaluation time — before `main()`'s
 * own try/catch below ever gets a turn. When this file is the CLI entry point,
 * report a thrown error the same documented way `main()` does (`console.error`
 * + exit 2) instead of letting it surface as an uncaught exception with a raw
 * stack trace. When this file is imported instead (as the test module does),
 * rethrow so the error still propagates normally.
 */
function initOrExit(fn) {
  try {
    return fn();
  } catch (err) {
    if (!isMainModule) throw err;
    console.error(`check:eager  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

/**
 * The `file` entries of `seo-artifacts.ts`'s `HTML_ENTRIES` map — the same map
 * `vite.config.ts:229` derives `rollupOptions.input` from — so a new entry
 * cannot be added to the build without this gate learning about it. Read via
 * the same TypeScript AST the import walk below uses, rather than an `import`,
 * because this script runs under plain `node` (no transpiler) and
 * `seo-artifacts.ts` is a `.ts` module.
 */
function readHtmlEntryFiles(root = REPO_ROOT) {
  const path = join(root, "scripts/seo-artifacts.ts");
  const source = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let entries;
  const visit = (node) => {
    if (entries === undefined && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "HTML_ENTRIES") {
      let init = node.initializer;
      while (init && ts.isAsExpression(init)) init = init.expression; // `{ … } as const`
      if (init && ts.isObjectLiteralExpression(init)) entries = init;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!entries) throw new Error(`${relative(root, path)}: HTML_ENTRIES object literal not found`);
  const files = [];
  for (const prop of entries.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
    for (const field of prop.initializer.properties) {
      if (
        ts.isPropertyAssignment(field) &&
        ts.isIdentifier(field.name) &&
        field.name.text === "file" &&
        ts.isStringLiteral(field.initializer)
      ) {
        files.push(field.initializer.text);
      }
    }
  }
  if (files.length === 0) throw new Error(`${relative(root, path)}: no "file" entries found in HTML_ENTRIES`);
  return files;
}

/** The HTML entries `vite.config.ts` builds; each names its module script. */
export const HTML_ENTRIES = initOrExit(() => readHtmlEntryFiles());

/**
 * The key names of `vite.config.ts`'s top-level `resolve.alias` (the build
 * alias table; `test.alias` is a separate, test-only block and deliberately
 * not read here). Only the string keys are extracted — the values are
 * identifiers (`DESIGN_TOKENS_DEFAULT`, …), not string literals, so
 * evaluating them would mean re-implementing a JS interpreter. `ALIAS_TARGETS`
 * below still hardcodes where each alias resolves; this function exists so
 * that a THIRD alias added to `vite.config.ts` is caught at module load
 * (see the check below `ALIAS_TARGETS`) instead of silently falling into
 * `resolveSpecifier`'s bare-package branch and being dropped as if it were an
 * unwalked npm import.
 */
function readViteAliasNames(root = REPO_ROOT) {
  const path = join(root, "vite.config.ts");
  const source = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let resolveObject;
  const findResolve = (node) => {
    if (
      resolveObject === undefined &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "resolve" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      resolveObject = node.initializer;
      return;
    }
    ts.forEachChild(node, findResolve);
  };
  findResolve(sf);
  if (!resolveObject) throw new Error(`${relative(root, path)}: top-level "resolve" object literal not found`);
  const names = [];
  for (const prop of resolveObject.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "alias" &&
      ts.isObjectLiteralExpression(prop.initializer)
    ) {
      for (const aliasProp of prop.initializer.properties) {
        if (ts.isPropertyAssignment(aliasProp) && ts.isStringLiteral(aliasProp.name)) {
          names.push(aliasProp.name.text);
        }
      }
    }
  }
  return names;
}

/** Alias specifier → resolved target, relative to the repo root. Every key
 *  `vite.config.ts`'s `resolve.alias` defines must appear here (checked
 *  below): the whole point is that a new alias there fails loudly rather than
 *  reaching `resolveSpecifier`'s `else return null` and being mistaken for an
 *  unresolved npm package. */
const ALIAS_TARGETS = {
  "@design-tokens": "src/design-system/styles/tokens.css",
  "@design-system": "src/design-system/index.ts",
};

initOrExit(() => {
  for (const name of readViteAliasNames()) {
    if (!(name in ALIAS_TARGETS)) {
      throw new Error(
        `vite.config.ts defines resolve.alias "${name}" that resolveSpecifier does not know how ` +
          `to resolve — add it to ALIAS_TARGETS in scripts/check-eager-graph.mjs`,
      );
    }
  }
});

/**
 * Parser modules that must load on demand, relative to the repo root. A match
 * is by exact path, or by prefix for an entry ending in `/`.
 *
 * Deliberately NOT listed: the leaves the eager lanes legitimately share —
 * `regex.ts` (edit-lane validators), `line-primitives.ts` (the exporter's
 * `isLoneDateRange`), `extract/title-shape.ts` (job-search), `extract/
 * corporate-suffix.ts`, `extract/work-authorization.ts` (disagreement layer)
 * and `extract/education-grade.ts` (the exporter's grade note). Each imports
 * nothing heavy. This list is hand-maintained, not derived from a shared
 * edge: `extract/education.ts` reaches neither `line-assembly.ts` nor
 * `entry-blocks.ts` (it is caught only because it is named below), and
 * `extract/skills.ts` is heavy via `line-assembly.ts` directly, not through
 * `entry-blocks.ts`.
 */
export const FORBIDDEN = [
  "src/lib/heuristics/line-assembly.ts",
  "src/lib/heuristics/entry-blocks.ts",
  "src/lib/heuristics/markdown-emit.ts",
  "src/lib/heuristics/sections.ts",
  "src/lib/heuristics/openresume.ts",
  "src/lib/heuristics/pdf-extract.ts",
  "src/lib/heuristics/extract-fields.ts",
  "src/lib/heuristics/extract/achievements.ts",
  "src/lib/heuristics/extract/education.ts",
  "src/lib/heuristics/extract/experience.ts",
  "src/lib/heuristics/extract/projects.ts",
  "src/lib/heuristics/extract/skills.ts",
];

/** Vite's default `resolve.extensions`, in order — what an extensionless
 *  specifier (or a directory) resolves to. Mirrors the bundler so a `./bridge`
 *  that lands on `bridge.js` is walked rather than dropped. */
export const RESOLVE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];

/** Files whose imports are read; anything else (`.css`, `.json`, `.svg`) is a
 *  leaf with no outgoing edges. */
const SCRIPT_EXTENSIONS = new Set([".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx"]);

function scriptKindFor(file) {
  switch (extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/** True when an import/export clause binds only types, which TypeScript elides
 *  entirely — so the module is never requested at runtime. */
function bindsOnlyTypes(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // side-effect `import "x"` — a real edge
    if (clause.isTypeOnly) return true;
    if (clause.name) return false; // a default binding is a value
    const named = clause.namedBindings;
    if (!named || ts.isNamespaceImport(named)) return false;
    return named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

/**
 * The static import specifiers of one module's source, in source order:
 * `import … from`, `export … from` and side-effect `import "…"`. Type-only
 * forms and dynamic `import()` are not edges. `fileName` picks the dialect
 * (TSX/JSX/JS); the default parses as TS.
 */
export function parseStaticImports(source, fileName = "module.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKindFor(fileName));
  const out = [];
  for (const node of sf.statements) {
    const isImport = ts.isImportDeclaration(node);
    const isReExport = ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined;
    if (!isImport && !isReExport) continue;
    if (bindsOnlyTypes(node)) continue;
    const spec = node.moduleSpecifier;
    if (spec && ts.isStringLiteral(spec)) out.push(spec.text);
  }
  return out;
}

/** Resolve a specifier from `fromFile` to an absolute path, or null when it is
 *  a bare package (not walked) or does not resolve to a file. */
export function resolveSpecifier(fromFile, spec, root = REPO_ROOT) {
  let base;
  if (spec in ALIAS_TARGETS) base = join(root, ALIAS_TARGETS[spec]);
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const isFile = (c) => existsSync(c) && statSync(c).isFile();
  if (isFile(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) if (isFile(`${base}${ext}`)) return `${base}${ext}`;
  for (const ext of RESOLVE_EXTENSIONS) if (isFile(join(base, `index${ext}`))) return join(base, `index${ext}`);
  return null;
}

/** The module script an HTML entry loads (`<script type="module" src="/src/…">`). */
export function entryFromHtml(htmlPath, root = REPO_ROOT) {
  const html = readFileSync(htmlPath, "utf8");
  const m = /<script[^>]*type="module"[^>]*src="\/([^"]+)"/.exec(html);
  if (!m) throw new Error(`${relative(root, htmlPath)}: no <script type="module" src="/…"> found`);
  return join(root, m[1]);
}

/**
 * Every file statically reachable from `entryFile`, as a Map of file → the file
 * it was first reached from (BFS parents, so `chainTo` gives a shortest chain).
 */
export function staticClosure(entryFile, root = REPO_ROOT) {
  const parent = new Map([[entryFile, null]]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!SCRIPT_EXTENSIONS.has(extname(file))) continue; // a leaf: css/json/svg
    const source = readFileSync(file, "utf8");
    for (const spec of parseStaticImports(source, file)) {
      const dep = resolveSpecifier(file, spec, root);
      if (dep && !parent.has(dep)) {
        parent.set(dep, file);
        queue.push(dep);
      }
    }
  }
  return parent;
}

/** The shortest static chain from the closure's entry to `target`, as
 *  repo-relative paths, or null when `target` is not in the closure. */
export function chainTo(closure, target, root = REPO_ROOT) {
  if (!closure.has(target)) return null;
  const chain = [];
  for (let n = target; n; n = closure.get(n)) chain.push(relative(root, n));
  return chain.reverse();
}

/** The forbidden modules an entry reaches, each with its shortest chain. */
export function violations(entryFile, forbidden = FORBIDDEN, root = REPO_ROOT) {
  const closure = staticClosure(entryFile, root);
  const out = [];
  for (const file of closure.keys()) {
    const rel = relative(root, file);
    const hit = forbidden.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f));
    if (hit) out.push({ module: rel, chain: chainTo(closure, file, root) });
  }
  return out.sort((a, b) => a.module.localeCompare(b.module));
}

export function main(root = REPO_ROOT) {
  let failed = false;
  for (const html of HTML_ENTRIES) {
    const entry = entryFromHtml(join(root, html), root);
    const found = violations(entry, FORBIDDEN, root);
    if (found.length === 0) {
      console.log(`check:eager  ${html} → ${relative(root, entry)}: clean`);
      continue;
    }
    failed = true;
    console.error(`check:eager  ${html} → ${relative(root, entry)}: ${found.length} forbidden module(s) on the eager graph`);
    for (const v of found) console.error(`  ${v.module}\n    ${v.chain.join("\n    → ")}`);
  }
  if (failed) {
    console.error("\nCut the chain with a dynamic import(), a type-only import, or by moving the symbol to a leaf module (see #1106).");
    return 1;
  }
  return 0;
}

if (isMainModule) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`check:eager  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}


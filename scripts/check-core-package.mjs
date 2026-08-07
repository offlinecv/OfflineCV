// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Publishability gate for `@offlinecv/core` (#772). Packs the package the way
 * `npm publish` would and consumes the resulting tarball the way a stranger
 * would, so the tarball's defects surface here rather than in the registry.
 *
 * WHY THIS EXISTS AT ALL. Every other check in this repo is a bundler. `tsc -b
 * --noEmit` typechecks the sources, `vite build` bundles them, and the one
 * consumer that exists resolves the package through a workspace link and
 * compiles its TypeScript itself. None of them loads the package the way a
 * published consumer does, so the entire class of "the tarball is wrong" is
 * invisible from inside the repo — green CI right up to the publish, where the
 * fix costs a version bump instead of a commit. Before #772 the `exports` map
 * pointed straight at `src/index.ts`, and `private: true` was the only thing
 * refusing the publish: dropping that one line would have handed every Node
 * consumer a file full of type annotations. #772 is what made that stop being
 * true, and this gate is what keeps it from becoming true again.
 *
 * THE LOAD-BEARING PART is not the import — it is the `node_modules/` this
 * script builds around the extracted tarball. It contains exactly the packages
 * the tarball's own `dependencies` names, symlinked out of the repo's install,
 * and nothing else. That is what makes the dependency list a claim under test:
 * `idb` is reached from `src/lib/storage/db.ts` and is now inside the emitted
 * copy this package ships, so dropping it from `dependencies` has to fail here.
 * It does — verified by deleting it and watching the import throw
 * `ERR_MODULE_NOT_FOUND`. Everything runs under the OS temp dir precisely so a
 * missing dependency cannot be satisfied by walking up into the repo's own
 * `node_modules`, which would turn the check into theatre.
 *
 * FIVE THINGS ARE ASSERTED, and each one maps to a way the tarball can be wrong:
 *
 *   1. Its SHAPE. No TypeScript source ships (that was the original defect), the
 *      per-file `.d.ts` tree does not ship either — `dist/index.d.ts` is the
 *      only declaration, because the per-file tree is unusable (see 4) — and
 *      every relative specifier in every shipped `.js` resolves to a file that
 *      also ships. That last one covers what assertion 2 structurally cannot:
 *      the probe imports the entry, so it only ever exercises the REACHABLE
 *      graph, while `tsc` emits a `.js` for every file in the program and
 *      `files` ships all of them. The unreachable remainder is never loaded by
 *      anything, so a dangling import inside it is silent forever. It is not
 *      hypothetical: 87 extensionless relative imports (`"../heuristics/
 *      sections"`, `"../html-to-markdown"`, …) survive elsewhere under `src/`,
 *      none of them in the emit closure today, and this package is `"type":
 *      "module"` — Node ESM does no extension search, so the first one pulled
 *      in ships broken. Reading is not resolution: `sections.config.js` imports
 *      `./sections.config.json` with no `with { type: "json" }` and so cannot
 *      itself load under Node, but the JSON does ship and the specifier does
 *      resolve, which is all this asserts.
 *   2. Its RUNTIME. The entry imports under plain Node with only its declared
 *      dependencies present, exports exactly the 22 names the barrel promises,
 *      and two of them are exercised for BEHAVIOUR rather than existence —
 *      `deriveJobId` has to still strip tracking parameters, `MAX_STARS` has to
 *      still be 5. A shape-only assertion passes on a tarball that exports 22
 *      broken functions.
 *   3. Its TYPES, from a consumer's position: a generated project resolves
 *      `@offlinecv/core` under `moduleResolution: "nodenext"` with
 *      `skipLibCheck: false` — the strictest configuration a plain Node consumer
 *      can have, and the first one to break. It carries a `@ts-expect-error`
 *      that only holds if the declarations were really read; if they resolved to
 *      nothing the symbols would widen to `any`, the expected error would
 *      vanish, and TypeScript would fail the unused directive.
 *   4. That no relative specifier survives in `dist/index.d.ts`. This is the
 *      subtle one. `rewriteRelativeImportExtensions` rewrites this repo's
 *      explicit `./foo.ts` specifiers to `./foo.js` in the JS output but NOT in
 *      the `.d.ts` output (TypeScript 5.8.3, under both `bundler` and
 *      `nodenext`). Since no `.ts` ships, a per-file declaration tree would
 *      dangle — which is why `rollup.dts.config.mjs` bundles the declarations
 *      into one specifier-free file, and why this assertion is how we find out
 *      if that step is ever removed or regresses.
 *   5. That every declared dependency is REQUIRED, not merely sufficient. The
 *      `node_modules/` above proves the list is big enough; nothing in it
 *      notices a dependency the code never imports, because a surplus symlink
 *      breaks nothing. So `dependencies` is compared, in both directions,
 *      against the packages a breadth-first walk from the entry actually
 *      reaches. Reachability rather than the file list, because the shipped
 *      remainder is full of modules nothing loads — two of them import
 *      `posthog-js` and `@mlc-ai/web-llm`, neither of which this package
 *      depends on in any sense a consumer would recognise.
 *      This is also what stands in for the rule `.fallowrc.jsonc` turns off
 *      here. fallow scopes dependency analysis to the workspace DIRECTORY, and
 *      `idb` is reached from the emit closure rather than from anything under
 *      `packages/core/`, so fallow reads it as unused and cannot reach a
 *      verdict about this package that is right. Walking the emitted graph can,
 *      which is why the suppression buys a stronger assertion rather than
 *      losing one.
 *
 * HERMETIC BY CONSTRUCTION: nothing here touches the network. The dependency
 * `node_modules` is symlinked from the repo's existing install rather than
 * installed from the registry, which is both offline AND the stronger test — a
 * registry install would happily resolve a transitive dependency this package
 * forgot to declare.
 *
 * Run:  npm run check:core
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_NAME = "@offlinecv/core";

/**
 * The package's whole runtime surface, spelled out rather than snapshotted.
 *
 * A published export list is an API promise, so a change to it should be a
 * deliberate edit to this array in the same commit — not a diff nobody reads.
 * The names are asserted as an exact SET, so an accidental ADDITION fails here
 * too: publishing a symbol is much easier than un-publishing one.
 */
const EXPECTED_EXPORTS = [
  "JOB_CAPTURE_CONTRACT_VERSION",
  "MAX_STARS",
  "canonicalJobUrl",
  "captureJob",
  "computeCoverageFromCorpus",
  "deleteRecord",
  "deriveJobId",
  "describeRating",
  "extractCompensation",
  "extractJdTerms",
  "formatCompensationRange",
  "getRecord",
  "getSyncCursor",
  "isBelowFloor",
  "listRecordsUpdatedSince",
  "listResumeChoices",
  "putRecord",
  "rateJobs",
  "ratingInputFor",
  "setSyncCursor",
  "validateJobRecord",
  "validateLetterRecord",
];

/**
 * Runs inside the extracted tarball's world. It imports by SPECIFIER, never by
 * path, so the `exports` map is what is under test — a path import would pass on
 * a package whose `exports` points nowhere.
 *
 * It reports rather than judges: the assertions live in the parent so every
 * failure message in this gate is written in one place.
 */
const PROBE = `import * as core from "@offlinecv/core";

process.stdout.write(
  JSON.stringify({
    exports: Object.keys(core).sort(),
    jobId: core.deriveJobId("https://ex.com/j/1?utm_source=x"),
    maxStars: core.MAX_STARS,
  }),
);
`;

/**
 * The consumer TypeScript. Deliberately small, and every line of it is an
 * assertion about the declarations rather than about this repo's logic.
 *
 * `ratingInputFor` takes a `RatingSignalSource`, which is not exported — a
 * consumer holding a `RankedJob` passes it structurally, and this file is where
 * we find out if that stops being true through the published surface.
 */
const CONSUMER_TS = `import { deriveJobId, validateJobRecord, MAX_STARS, ratingInputFor } from "@offlinecv/core";
import type { JobRecord, RankedJob, CoverageResult } from "@offlinecv/core";

export const id: string | undefined = deriveJobId("https://ex.com/j/1");
export const stars: number = MAX_STARS;

// \`deriveJobId\` answers \`string | undefined\` — a URL it cannot canonicalise has
// no id. If the declarations failed to resolve, every symbol here would widen to
// \`any\`, this error would not happen, and TypeScript would fail the unused
// directive. That is the point: it fails in BOTH directions.
// @ts-expect-error deriveJobId can miss, so its result is not assignable to string
export const mustNotCompile: string = deriveJobId("https://ex.com/j/1");

export function consume(record: JobRecord, ranked: RankedJob, coverage: CoverageResult) {
  return [
    validateJobRecord(record),
    ratingInputFor(ranked, undefined, undefined, undefined),
    coverage,
  ] as const;
}
`;

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    // The surface is browser-only — its declarations name IndexedDB and
    // BroadcastChannel types, so a consumer without the DOM lib cannot read them
    // at all. Saying so here keeps that a stated constraint rather than a
    // surprise.
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    // The whole point of the run. `skipLibCheck: true` — this repo's own setting
    // — would swallow exactly the dangling-specifier defect assertion 4 guards.
    skipLibCheck: false,
    noEmit: true,
    // No ambient `@types/*` from anywhere: the package must typecheck on its own
    // declarations, not on whatever a consumer happens to have installed.
    types: [],
  },
  include: ["consumer.ts"],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * What the tarball CONTAINS, read out of the tarball rather than off the
 * extracted tree — the two can differ (this script writes a `node_modules/`
 * into the extraction below), and the shipped file list is the thing under
 * test. npm tarballs always root every entry at `package/`.
 */
function packedFiles(listing) {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//, ""))
    .sort();
}

/**
 * Every import/export specifier in one emitted JavaScript file.
 *
 * The scan PARSES the file with `ts.createSourceFile` — the compiler's own
 * parser — and reads the module specifiers off the resulting AST, precisely so
 * it sees what the compiler sees rather than what a regex guesses. A pattern
 * sweep has to choose between two failures and both are live on this emit.
 * Unanchored, it reads prose as code: the docblocks survive into the emit
 * verbatim, so one comment documenting a relative dynamic import fails the gate
 * naming a specifier that does not exist. Anchored to column 0, it cannot cross
 * a quote inside the statement, which is exactly what an ES2022 arbitrary
 * module namespace name puts there — `export { X as "some-name" } from "…"`,
 * emitted verbatim under this repo's build flags — so the statement is skipped
 * and its specifier never checked at all. That is the same dangling-specifier
 * defect this gate exists to catch, differing only in the export name. A parse
 * has neither problem: a comment is not a node and a string literal in
 * expression position is not an `ImportDeclaration`, while a string export name
 * is just another node inside a clause the parser already understands.
 * `typescript` is already a direct root `devDependency`, so reaching for it adds
 * nothing to the install.
 *
 * WHY A PARSE RATHER THAN A SCAN. This one function has now shipped a dangling
 * specifier twice, each time by silently dropping a whole statement form while
 * the gate still printed `✓ publishable`: a hand-rolled line-anchored regex
 * could not cross the quote in `export { X as "s" } from "…"`, and its
 * replacement, `ts.preProcessFile`, is a token scanner rather than a parser and
 * missed `export * as ns from "…"` — its asterisk branch looks only for `from`
 * and has no `as` handling, unlike the import branch beside it. Both approximate
 * the module grammar and both lost to it. A silent PER-STATEMENT miss is the
 * worst failure mode this gate has, because everything around it still looks
 * right — the build is green, the probe imports, the file list is correct, and
 * the one edge nobody checked ships broken. That is the constraint this function
 * guards, and only the real parser guards it.
 *
 * KNOWN LIMIT, shared by every static scanner including this one: a COMPUTED
 * dynamic import has no literal specifier to report — `tsc` emits those as
 * ``__rewriteRelativeImportExtension(`./${name}.ts`)`` — so a template-literal
 * import cannot be resolved here, or by the compiler.
 */
function importSpecifiers(source) {
  const parsed = ts.createSourceFile("emitted.js", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const specifiers = [];

  // Only a real string literal is a resolvable specifier. A computed or
  // template-literal one (see KNOWN LIMIT) is skipped rather than stringified,
  // which would invent a path and fail the gate on a specifier nobody wrote.
  const record = (node) => {
    if (node && ts.isStringLiteral(node)) specifiers.push(node.text);
  };

  const visit = (node) => {
    // `ExportDeclaration` is the load-bearing one: it is every `export … from`
    // form at once — `export * from`, `export * as ns from`, `export * as "s"
    // from`, `export { X as "s" } from` — so covering the node covers all of
    // them, including the ones a scanner has to special-case one at a time.
    // Its `moduleSpecifier` is absent on a local `export { X }`, which `record`
    // handles.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0]);
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);
  return specifiers;
}

/**
 * `execFileSync` with the child's stderr folded into the thrown message.
 *
 * Without this, a failing `tsc` or a failing `node` surfaces as
 * `Command failed with exit code 1` and the diagnostic — the thing that names
 * WHICH export is missing or WHICH type stopped resolving — is discarded.
 */
function run(file, args, cwd) {
  try {
    return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const detail = [err?.stdout, err?.stderr].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
    throw new Error(`\`${file} ${args.join(" ")}\` failed:\n${detail || String(err?.message ?? err)}`);
  }
}

// ── The four assertions ─────────────────────────────────────────────────────

/**
 * The npm package a bare specifier resolves to: `idb` from `idb`, `foo` from
 * `foo/bar.js`, `@scope/pkg` from `@scope/pkg/sub`. Node builtins answer null —
 * they are satisfied by the runtime, so they are never a dependency.
 */
function packageNameOf(specifier) {
  if (specifier.startsWith("node:")) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return builtinModules.includes(name) ? null : name;
}

/**
 * 1. Shape: no TypeScript source, one declaration file rather than a tree, and
 *    no shipped module importing a sibling that did not ship. Returns the module
 *    graph — every shipped module's specifiers, keyed by path — so assertion 5
 *    can walk it without re-parsing.
 */
function checkTarballShape(shipped, pkg, fail) {
  const graph = new Map();
  const sources = shipped.filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  if (sources.length > 0)
    fail(
      `the tarball ships ${sources.length} TypeScript source file(s) — ${sources.slice(0, 5).join(", ")}. ` +
        `No runtime resolves a \`.ts\` specifier; \`files\` must ship the BUILD OUTPUT, not \`src/\`.`,
    );

  const declarations = shipped.filter((p) => p.endsWith(".d.ts"));
  if (!declarations.includes("dist/index.d.ts"))
    fail("the tarball has no `dist/index.d.ts` — the bundled declaration `exports.types` points at.");
  const extra = declarations.filter((p) => p !== "dist/index.d.ts");
  if (extra.length > 0)
    fail(
      `the tarball ships ${extra.length} per-file declaration(s) alongside the bundle — ` +
        `${extra.slice(0, 5).join(", ")}. They carry unresolvable \`.ts\` specifiers (see assertion 4); ` +
        `narrow \`files\` so only \`dist/index.d.ts\` ships.`,
    );

  // Every internal edge lands on a file that shipped. Bare specifiers are
  // assertion 2's job (they resolve against `dependencies`, which the probe puts
  // under test); these are the ones only the tarball's own file list can answer.
  const packedSet = new Set(shipped);
  // `.mjs`/`.cjs` as well as `.js` — defence in depth, not a live check. `files`
  // ships `dist/**/*.js` only, so the `.mjs` a future `.mts` source would emit
  // cannot reach `shipped` unless `files` is widened in the same change. The
  // wider pattern does not close that gap on its own; it means only one of the
  // two edits has to be remembered rather than both.
  for (const file of shipped.filter((p) => /\.[mc]?js$/.test(p))) {
    const source = readFileSync(join(pkg, file), "utf8");
    const specifiers = importSpecifiers(source);
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      // Exact resolution, deliberately: `"type": "module"` means Node ESM, which
      // appends no extension and tries no `/index.js`. An extensionless
      // specifier resolving to nothing here is the real runtime behaviour.
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!packedSet.has(resolved))
        fail(
          `${file} imports "${specifier}", which resolves to ${resolved} — a path the tarball does not ship. ` +
            `Under \`"type": "module"\` Node appends no extension and tries no \`/index.js\`, so this import ` +
            `throws \`ERR_MODULE_NOT_FOUND\` the first time anything loads ${file}. Either give the specifier ` +
            `the explicit extension this repo's convention requires, or ship the missing file via \`files\`.`,
        );
    }
  }

  return graph;
}

/**
 * 5. Necessity: `dependencies` and the packages the tarball actually loads agree.
 *
 * Judged over the REACHABLE graph — a breadth-first walk from the entry
 * `exports` points at, following the relative edges assertion 1 already proved
 * land on shipped files — and not over the shipped file list. The difference is
 * load-bearing here, because `tsc` emits a `.js` for every file in the program
 * and `files` ships all of them: the unreachable remainder includes modules that
 * import `posthog-js` and `@mlc-ai/web-llm`, and nothing ever loads them. A
 * consumer that installed those would be paying for code Node never resolves.
 * Reachability is what decides whether a package is a dependency; shipping a
 * file that mentions it is not.
 *
 * The direction that matters is EXTRA — a dependency nothing imports, which no
 * other assertion can see, because the `node_modules/` built for assertion 2
 * proves only that the list is big ENOUGH. A surplus symlink breaks nothing. The
 * missing direction is already fatal at import time, but it is asserted here too
 * so the failure names the specifier instead of an `ERR_MODULE_NOT_FOUND` stack.
 */
function checkDeclaredDependencies(declared, graph, entry, fail) {
  // Without this the walk starts nowhere, reaches nothing, and reports every
  // declared dependency as surplus — a confident wrong answer rather than a
  // failure. `exports` moving is exactly the change that would cause it.
  if (!graph.has(entry)) {
    fail(`the entry \`exports\` points at (${entry}) is not among the shipped modules this gate parsed.`);
    return;
  }

  const required = new Set();
  const seen = new Set([entry]);
  for (const queue = [entry]; queue.length > 0; ) {
    const file = queue.shift();
    for (const specifier of graph.get(file) ?? []) {
      if (!specifier.startsWith(".")) {
        const name = packageNameOf(specifier);
        if (name) required.add(name);
        continue;
      }
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }

  const extra = declared.filter((name) => !required.has(name));
  if (extra.length > 0)
    fail(
      `${PKG_NAME} declares dependenc${extra.length === 1 ? "y" : "ies"} nothing reachable from the ` +
        `entry imports: ${extra.join(", ")}. Every consumer pays to install ` +
        `${extra.length === 1 ? "it" : "them"} for code Node never loads; drop ` +
        `${extra.length === 1 ? "it" : "them"} from \`dependencies\`, or export the module that needs ` +
        `${extra.length === 1 ? "it" : "them"}.`,
    );

  const undeclared = [...required].filter((name) => !declared.includes(name));
  if (undeclared.length > 0)
    fail(
      `the tarball imports ${undeclared.join(", ")} but does not declare ` +
        `${undeclared.length === 1 ? "it" : "them"} in \`dependencies\`. A consumer's install would not ` +
        `place ${undeclared.length === 1 ? "it" : "them"}, so the import throws \`ERR_MODULE_NOT_FOUND\`.`,
    );
}

/** 2. Runtime: the exact export set, plus behaviour behind two of the names. */
function checkRuntimeSurface(probe, fail) {
  const missing = EXPECTED_EXPORTS.filter((name) => !probe.exports.includes(name));
  const unexpected = probe.exports.filter((name) => !EXPECTED_EXPORTS.includes(name));
  if (missing.length > 0) fail(`the tarball is missing export(s): ${missing.join(", ")}`);
  if (unexpected.length > 0)
    fail(
      `the tarball exports name(s) this gate does not know about: ${unexpected.join(", ")}. ` +
        `If that is intended, add them to EXPECTED_EXPORTS in the same commit — a published ` +
        `export is a promise.`,
    );

  // Behaviour, not shape. `deriveJobId` canonicalising the URL is the whole
  // reason `docs/job-capture-contract.md` tells producers to use it rather than
  // roll their own: a copy that keeps `utm_source` forks the id space and turns
  // every re-capture into a duplicate row.
  if (probe.jobId !== "job:ex.com/j/1")
    fail(`deriveJobId() returned ${JSON.stringify(probe.jobId)} through the tarball, expected "job:ex.com/j/1"`);
  if (probe.maxStars !== 5) fail(`MAX_STARS is ${JSON.stringify(probe.maxStars)} through the tarball, expected 5`);
}

/** 4. No relative specifier survives the declaration bundle. */
function checkDeclarationBundle(dts, fail) {
  const relative = [...dts.matchAll(/\bfrom\s*["'](\.[^"']*)["']/g)].map((m) => m[1]);
  if (relative.length > 0)
    fail(
      `dist/index.d.ts still imports ${relative.length} relative specifier(s) — ${[...new Set(relative)].slice(0, 5).join(", ")}. ` +
        `The tarball ships no per-file declarations for them to resolve to, so a consumer would ` +
        `fall back to \`any\` or fail outright. \`rollup.dts.config.mjs\` exists to inline these.`,
    );
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const failures = [];
  const fail = (message) => failures.push(message);

  const tmp = mkdtempSync(join(tmpdir(), "offlinecv-core-pack-"));
  try {
    // `npm pack` runs the package's `prepare`, so the tarball is built from
    // current sources either way — but building explicitly first means a broken
    // build reports as a broken build rather than as a mystery inside `pack`.
    run("npm", ["run", "build", "-w", PKG_NAME], ROOT);
    run("npm", ["pack", "-w", PKG_NAME, "--pack-destination", tmp], ROOT);

    const tarball = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error(`\`npm pack\` produced no tarball in ${tmp}`);

    // The file LIST comes from the tarball and the file BODIES from the
    // extraction, so the shape check has to run after this — but it still judges
    // only what `tar -tzf` reported, before the `node_modules/` written below
    // makes the extracted tree stop matching what ships.
    const shipped = packedFiles(run("tar", ["-tzf", join(tmp, tarball)], ROOT));

    const extractRoot = join(tmp, "extracted");
    mkdirSync(extractRoot);
    run("tar", ["-xzf", join(tmp, tarball), "-C", extractRoot], ROOT);
    const pkg = join(extractRoot, "package");

    const graph = checkTarballShape(shipped, pkg, fail);

    // The load-bearing step: ONLY the declared dependencies, and they come from
    // the repo's install rather than the registry so this stays offline.
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const declared = Object.keys(manifest.dependencies ?? {});
    // Read off `exports` rather than hardcoded, so repointing the entry moves
    // what assertion 5 walks instead of silently leaving it behind.
    const entry = posix.normalize(manifest.exports?.["."]?.default ?? "");
    checkDeclaredDependencies(declared, graph, entry, fail);
    mkdirSync(join(pkg, "node_modules"));
    for (const dep of declared) {
      const source = join(ROOT, "node_modules", dep);
      if (!existsSync(source))
        throw new Error(
          `${PKG_NAME} declares "${dep}", which is not installed at the repo root — ` +
            `run \`npm install\` before this gate, or fix the dependency name.`,
        );
      const target = join(pkg, "node_modules", dep);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, "dir");
    }

    // A consumer that reaches the package the only way a stranger can: by name,
    // through `exports`.
    const consumer = join(tmp, "consumer");
    mkdirSync(join(consumer, "node_modules", "@offlinecv"), { recursive: true });
    symlinkSync(pkg, join(consumer, "node_modules", "@offlinecv", "core"), "dir");
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "core-tarball-consumer", version: "0.0.0", private: true, type: "module" }, null, 2),
    );
    writeFileSync(join(consumer, "probe.mjs"), PROBE);
    writeFileSync(join(consumer, "consumer.ts"), CONSUMER_TS);
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(CONSUMER_TSCONFIG, null, 2));

    checkRuntimeSurface(JSON.parse(run(process.execPath, ["probe.mjs"], consumer)), fail);
    run(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(consumer, "tsconfig.json")], consumer);
    checkDeclarationBundle(readFileSync(join(pkg, "dist", "index.d.ts"), "utf8"), fail);

    if (failures.length === 0) {
      console.log(
        `✓ ${PKG_NAME} is publishable: ${shipped.length} file(s) packed, ` +
          `${EXPECTED_EXPORTS.length} export(s) imported under plain Node with only ` +
          `${declared.length === 0 ? "no" : declared.join(", ")} dependenc${declared.length === 1 ? "y" : "ies"} ` +
          `present, and a \`nodenext\` consumer typechecks against dist/index.d.ts with skipLibCheck off.`,
      );
      return;
    }
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(
      `\n${failures.length} problem(s) would ship in the ${PKG_NAME} tarball. ` +
        `See scripts/check-core-package.mjs for what each assertion protects.`,
    );
    process.exitCode = 1;
  } catch (err) {
    // A thrown error is the pack/import/typecheck itself failing — which IS the
    // finding, not an infrastructure problem to swallow.
    console.error(`✗ ${PKG_NAME} could not be packed and consumed:\n${err.message}`);
    // Anything already COLLECTED still prints. The two are usually the same
    // defect seen twice, and the collected one is the readable half: an
    // undeclared dependency is a named specifier here and an
    // `ERR_MODULE_NOT_FOUND` stack above. Losing it to the throw would hide the
    // sentence that says what to change.
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();

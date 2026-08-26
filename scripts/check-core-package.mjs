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
 * SEVEN THINGS ARE ASSERTED, and each one maps to a way the tarball can be wrong:
 *
 *   1. Its SHAPE. No TypeScript source ships (that was the original defect), the
 *      per-file `.d.ts` tree does not ship either — the only declarations are one
 *      bundle per `exports` entry, because the per-file tree is unusable (see 4)
 *      — and every relative specifier in every shipped `.js` resolves to a file that
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
 *   2. Its RUNTIME. Every entry `EXPECTED_EXPORTS` names imports under plain
 *      Node with only the declared dependencies present, exporting exactly the
 *      names its barrel promises — and assertion 7 is what makes "every entry
 *      `EXPECTED_EXPORTS` names" the same set as "every entry `exports`
 *      publishes", which it was not until that assertion existed. Three names
 *      are exercised for BEHAVIOUR rather than
 *      existence — `deriveJobId` has to still strip tracking parameters,
 *      `MAX_STARS` has to still be 5, and `getProviders()` has to still answer
 *      the three keyless feeds in display order. A shape-only assertion passes
 *      on a tarball that exports twenty-nine broken functions.
 *      The same assertion covers what `exports` REFUSES: three subpaths that
 *      name real shipped files have to fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`
 *      (see `UNEXPORTED_SUBPATHS`). That is the only thing standing between a
 *      consumer and the 24 unreachable emitted modules, two of which
 *      dynamic-import packages this one does not depend on.
 *   3. Its TYPES, from a consumer's position: a generated project resolves
 *      `@offlinecv/core` and `@offlinecv/core/job-search` under
 *      `moduleResolution: "nodenext"` with
 *      `skipLibCheck: false` — the strictest configuration a plain Node consumer
 *      can have, and the first one to break. It carries a `@ts-expect-error`
 *      that only holds if the declarations were really read; if they resolved to
 *      nothing the symbols would widen to `any`, the expected error would
 *      vanish, and TypeScript would fail the unused directive.
 *   4. That no relative specifier survives in any shipped declaration bundle.
 *      This is the subtle one. `rewriteRelativeImportExtensions` rewrites this
 *      repo's explicit `./foo.ts` specifiers to `./foo.js` in the JS output but
 *      NOT in the `.d.ts` output (TypeScript 5.8.3, under both `bundler` and
 *      `nodenext`). Since no `.ts` ships, a per-file declaration tree would
 *      dangle — which is why `rollup.dts.config.mjs` bundles the declarations
 *      into one specifier-free file per entry, and why this assertion is how we
 *      find out if that step is ever removed or regresses.
 *   5. That every declared dependency is REQUIRED, not merely sufficient. The
 *      `node_modules/` above proves the list is big enough; nothing in it
 *      notices a dependency the code never imports, because a surplus symlink
 *      breaks nothing. So `dependencies` is compared, in both directions,
 *      against the packages a breadth-first walk from EVERY entry actually
 *      reaches — the union, because `dependencies` is one list for the whole
 *      package and a package imported only from `./job-search` is still
 *      required. Reachability rather than the file list, because the shipped
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
 *   6. Each entry's value-edge CLOSURE: how many modules it reaches, how many of
 *      those name a network primitive, and that no two entries share one. This
 *      is the property the `./job-search` split exists to create, and nothing
 *      else here can see it. Assertion 2 catches a provider SYMBOL moved onto
 *      `.`; only a graph walk catches a value EDGE, and the edge is the cheaper
 *      accident — a single `import "…/fetch-jd.ts";` side-effect line changes no
 *      export name at all while putting a live `fetch(` on the entry whose
 *      docblock says it reaches none. See `ENTRY_CLOSURES`.
 *   7. That the manifest's `exports`, `EXPECTED_EXPORTS` and `ENTRY_CLOSURES`
 *      describe the SAME set of subpaths. Assertions 1, 4, 5 and 6 read their
 *      subpaths off the manifest and follow a new entry automatically; the two
 *      tables above are hand-written and do not. Until this was asserted, a
 *      subpath added to `exports` and nowhere else published an unreviewed
 *      export surface with the gate green — counted in the success line,
 *      typechecked for nothing, asserted about in no way.
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
 * The package's whole runtime surface, spelled out rather than snapshotted, one
 * list per entry point in `exports`.
 *
 * A published export list is an API promise, so a change to it should be a
 * deliberate edit to this object in the same commit — not a diff nobody reads.
 * The names are asserted as an exact SET per subpath, so an accidental ADDITION
 * fails here too: publishing a symbol is much easier than un-publishing one.
 *
 * Keyed by subpath rather than flattened into one list, because WHICH entry a
 * symbol is on is the load-bearing part. `./job-search` is the network-bearing
 * half of this package — every adapter it exports holds a `fetch(` — and the
 * whole reason it is a second subpath is that `.`'s consumers audit their import
 * graphs and must not reach one. A flat list would go green on a commit that
 * moved a provider onto `.`, which is exactly the regression the split exists to
 * prevent; this shape fails it by name.
 */
const EXPECTED_EXPORTS = {
  ".": [
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
  ],
  "./job-search": [
    "KEYLESS_PROVIDERS",
    "getProviders",
    "greenhouseJobId",
    "hydrateGreenhouse",
    "hydrateLever",
    "leverJobId",
    "makeAshbyProvider",
    "makeGreenhouseProvider",
    "makeLeverProvider",
  ],
};

/**
 * The VALUE-EDGE CLOSURE of each entry, measured on the emitted `dist/` — the
 * property the two-entry split exists to create, and the one thing no other
 * assertion here can see.
 *
 * `EXPECTED_EXPORTS` above catches a provider SYMBOL moved onto `.`. It cannot
 * catch a value EDGE, which is the cheaper mistake by far: one
 * `import "…/fetch-jd.ts";` side-effect line in `src/index.ts` leaves the export
 * set byte-identical while taking that closure from 28 modules to 30, putting a
 * live `fetch(` on it, and making the two closures overlap. At that point every
 * network-free claim in `src/index.ts`, `src/job-search.ts` and
 * `tsconfig.build.json` is false — in a public repo — and the downstream
 * extension's `no-network.test.ts` is the first thing that finds out.
 *
 * So the numbers are asserted, exactly, in both directions. They are named
 * constants sitting next to the docblocks they defend precisely so a legitimate
 * change has to come here and update them deliberately, rather than watching a
 * threshold absorb it.
 *
 *   modules              — the count of shipped `.js` files the entry reaches by
 *                          value edges, itself included.
 *   networkBearingModules — how many of those name a network primitive. ZERO is
 *                          `.`'s whole claim. SEVEN is `./job-search`'s product,
 *                          asserted in the same breath so a closure that quietly
 *                          became a stub fails too — the six adapters plus
 *                          `jd-match/fetch-jd.js`, which they take
 *                          `htmlToPlaintext` from.
 *
 * Every key here is cross-checked against `exports` and `EXPECTED_EXPORTS` (see
 * `checkPublishedSubpaths`), so a third entry cannot skip this table and leave
 * the assertion silently covering two of three surfaces.
 */
const ENTRY_CLOSURES = {
  ".": { modules: 28, networkBearingModules: 0 },
  "./job-search": { modules: 11, networkBearingModules: 7 },
};

/**
 * The four primitives a network-free claim is about.
 *
 * Matched by PARSING the emitted JavaScript rather than sweeping it, for the
 * same reason `importSpecifiers` does — and here the difference is not
 * theoretical but load-bearing on the very first run. `tsc` preserves docblocks
 * into the emit verbatim, and the emitted `.` entry contains the sentence "the
 * value-edge closure of the specifiers below is 28 modules and reaches no
 * `fetch`/`WebSocket`/…" — so the obvious `/\b(fetch|…)\s*\(/` sweep reports
 * FOUR network primitives in the one file whose whole claim is that it has
 * none. A comment is not a node; the parse simply does not see it.
 *
 * The parse is also strictly stronger than the sweep on real code: it reads
 * `globalThis.fetch(url)` (a property-access NAME) and a bare alias
 * `const f = fetch;` (no paren follows, so no `\s*\(` sweep can), while
 * declining to flag a BINDING of the same name — `function fetch()`,
 * `let fetch`, `{ fetch: myImpl }` — which introduces a local rather than
 * reading the global.
 *
 * KNOWN LIMIT, shared with every static scanner: a computed access
 * (`globalThis["fet" + "ch"]`) has no identifier to read. Anything determined
 * enough to write that is past what a gate in this repo is defending against.
 */
const NETWORK_PRIMITIVES = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]);

/**
 * Every place a THIRD entry point has to be added. Written once, here, and
 * quoted by the failure message below rather than paraphrased in each file —
 * three separately-drifting copies of this list is what let the gap
 * `checkPublishedSubpaths` now closes exist in the first place.
 */
const THIRD_ENTRY_CHECKLIST = [
  "packages/core/package.json → `exports` (the subpath, with `types` + `default`)",
  "packages/core/package.json → `files` (its `dist/<name>.d.ts`)",
  "packages/core/tsconfig.build.json → `include` (or `tsc` emits no `.js` for it)",
  "packages/core/rollup.dts.config.mjs → a declaration bundle",
  "scripts/check-core-package.mjs → EXPECTED_EXPORTS, ENTRY_CLOSURES, and a PROBE static import",
  ".fallowrc.jsonc → `entry` (unless the file is named `index.ts`)",
];

/**
 * Subpaths a consumer might plausibly reach for and must NOT get.
 *
 * This is the assertion behind the barrels' claim that the unreachable dead JS
 * in the tarball "is not an egress path". `analytics.js` and `web-llm.js` are
 * shipped, are unreachable from either entry, and dynamic-import packages this
 * one does not depend on; what stops a consumer loading them anyway is `exports`
 * declaring two subpaths and no wildcard. Verified rather than asserted, because
 * a single `"./*"` entry added for convenience would silently publish all 62
 * emitted modules.
 *
 * The three are deliberately different shapes, and only the first two name a
 * file the tarball really ships — for those, an absent path would prove nothing,
 * since it would fail for the boring reason. The THIRD names no shipped file and
 * is not meant to: it is a deep subpath under an already-exported prefix, the
 * shape a `"./job-search/*"` pattern would publish, which the first two (both
 * `dist/…` paths, covered by a bare `"./*"`) would not catch. There is no
 * false-pass risk in that: Node resolves `exports` by pattern match and never
 * touches the filesystem for a subpath the map does not name, so the refusal
 * this asserts is `exports`' doing rather than the file's absence.
 */
const UNEXPORTED_SUBPATHS = [
  "@offlinecv/core/dist/src/lib/analytics.js",
  "@offlinecv/core/dist/packages/core/src/index.js",
  "@offlinecv/core/job-search/providers",
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
import * as jobSearch from "@offlinecv/core/job-search";

// The subpath list is generated from EXPECTED_EXPORTS rather than written twice.
// Spelled out, a third entry added there and forgotten here would report every
// one of its names as missing — a correct failure with a misleading message. The
// static imports above stay static because a namespace object is what the export
// check needs and because a bare \`import()\` of a subpath nobody declared would
// fail for the wrong reason; they are asserted against this list below.
const exports = {};
for (const subpath of ${JSON.stringify(Object.keys(EXPECTED_EXPORTS))}) {
  const loaded = subpath === "." ? core : subpath === "./job-search" ? jobSearch : null;
  if (loaded === null) throw new Error(\`PROBE has no static import for the "\${subpath}" entry — add one.\`);
  exports[subpath] = Object.keys(loaded).sort();
}

const blocked = {};
for (const specifier of ${JSON.stringify(UNEXPORTED_SUBPATHS)}) {
  try {
    await import(specifier);
    blocked[specifier] = "RESOLVED";
  } catch (err) {
    blocked[specifier] = err?.code ?? String(err?.message ?? err);
  }
}

process.stdout.write(
  JSON.stringify({
    exports,
    blocked,
    jobId: core.deriveJobId("https://ex.com/j/1?utm_source=x"),
    maxStars: core.MAX_STARS,
    // Behaviour behind the subpath, for assertion 2's reason: a shape-only check
    // passes on a tarball exporting seven broken adapters. \`getProviders()\` with
    // no argument must still answer exactly the always-on keyless set, which is
    // the call a poller with no company selection makes.
    keylessIds: jobSearch.getProviders().map((provider) => provider.id),
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
import { getProviders } from "@offlinecv/core/job-search";
import type { JobPosting, JobQuery } from "@offlinecv/core/job-search";

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

// The subpath's declarations, exercised the way a poller uses them: build a
// \`JobQuery\` literal (the extension consumer cannot call \`buildJobQuery\` — that
// wants a whole parsed résumé, which it is built never to hold), fan out, and
// get \`JobPosting[]\` back. If \`dist/job-search.d.ts\` failed to resolve, every
// symbol here would widen to \`any\` and the annotations would stop meaning
// anything — which is what the \`@ts-expect-error\` above catches for \`.\`.
export async function search(signal: AbortSignal): Promise<JobPosting[]> {
  const query: JobQuery = { titles: ["Staff Engineer"], skills: ["typescript"] };
  const results = await Promise.all(getProviders().map((provider) => provider.search(query, signal)));
  return results.flat();
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
  const needsShell = process.platform === "win32" && (file === "npm" || file.includes(".bin"));
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
    });
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
function checkTarballShape(shipped, pkg, declarationEntries, fail) {
  const graph = new Map();
  const sources = shipped.filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  if (sources.length > 0)
    fail(
      `the tarball ships ${sources.length} TypeScript source file(s) — ${sources.slice(0, 5).join(", ")}. ` +
        `No runtime resolves a \`.ts\` specifier; \`files\` must ship the BUILD OUTPUT, not \`src/\`.`,
    );

  // The expected set is READ OFF `exports[*].types` rather than hardcoded, so a
  // new entry point moves what this asserts instead of failing here for the
  // wrong reason — and so an entry whose bundle was never wired into
  // `rollup.dts.config.mjs` fails as "the tarball has no …" rather than shipping
  // a `types` path that resolves to nothing.
  const declarations = shipped.filter((p) => p.endsWith(".d.ts"));
  for (const expected of declarationEntries) {
    if (!declarations.includes(expected))
      fail(
        `the tarball has no \`${expected}\` — a bundled declaration an \`exports\` entry's ` +
          `\`types\` points at. Add it to \`rollup.dts.config.mjs\` and to \`files\`.`,
      );
  }
  const extra = declarations.filter((p) => !declarationEntries.includes(p));
  if (extra.length > 0)
    fail(
      `the tarball ships ${extra.length} per-file declaration(s) alongside the ` +
        `${declarationEntries.length} bundle(s) — ${extra.slice(0, 5).join(", ")}. They carry ` +
        `unresolvable \`.ts\` specifiers (see assertion 4); narrow \`files\` so only ` +
        `${declarationEntries.join(", ")} ship.`,
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
 * Every network primitive NAMED in one emitted JavaScript file.
 *
 * Parsed, not swept — see `NETWORK_PRIMITIVES` for why the obvious regex reports
 * four `fetch(`s in the one file whose entire claim is that it has none.
 */
function networkPrimitivesIn(source) {
  // `setParentNodes` is what lets the binding/reference distinction below be
  // made at all; `importSpecifiers` does not need it and does not pay for it.
  const parsed = ts.createSourceFile("emitted.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Set();

  const visit = (node) => {
    if (ts.isIdentifier(node) && NETWORK_PRIMITIVES.has(node.text)) {
      const parent = node.parent;
      // A BINDING of the name rather than a READ of the global: `function
      // fetch()`, `let fetch`, `class fetch`, `{ fetch: myImpl }`. Introducing a
      // local called `fetch` reaches no network. The one `name` position that is
      // still a read is a property access — `globalThis.fetch` — so it is
      // excluded from the exclusion.
      const isBinding =
        parent !== undefined &&
        !ts.isPropertyAccessExpression(parent) &&
        !ts.isShorthandPropertyAssignment(parent) &&
        "name" in parent &&
        parent.name === node;
      if (!isBinding) found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);
  return [...found].sort();
}

/**
 * 6. The value-edge CLOSURE of each entry: its size, its network primitives, and
 *    its disjointness from every other entry's.
 *
 * This is the assertion the two-entry split exists for, and until it was written
 * nothing in the repo made the property it creates checkable. `EXPECTED_EXPORTS`
 * sees a provider SYMBOL arriving on `.`; only a graph walk sees a value EDGE,
 * and the edge is the cheaper accident — a bare `import "…/fetch-jd.ts";` moves
 * no export name at all.
 *
 * Walked over `graph`, which assertion 1 already built by parsing every shipped
 * `.js` and already proved lands only on files that ship. The three claims are
 * asserted separately rather than rolled into one number because they fail for
 * different reasons and a reader needs to know which: a count drift is a
 * dependency someone added, a network primitive on `.` is a shipped privacy
 * defect, and an overlap is the seam itself dissolving.
 */
function checkEntryClosures(graph, pkg, entryFor, fail) {
  const closures = new Map();

  for (const [subpath, entry] of entryFor) {
    // A subpath with no row here is already failing by name in
    // `checkPublishedSubpaths`; walking it would only add a second, vaguer
    // message about a table it was never in.
    const expected = ENTRY_CLOSURES[subpath];
    if (!expected) continue;

    const closure = new Set([entry]);
    for (const queue = [entry]; queue.length > 0; ) {
      const file = queue.shift();
      for (const specifier of graph.get(file) ?? []) {
        if (!specifier.startsWith(".")) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (closure.has(resolved)) continue;
        closure.add(resolved);
        queue.push(resolved);
      }
    }
    closures.set(subpath, closure);

    if (closure.size !== expected.modules)
      fail(
        `the \`${subpath}\` entry's value-edge closure is ${closure.size} module(s), and ENTRY_CLOSURES ` +
          `says ${expected.modules}. Either an edge was added that should not have been, or the change is ` +
          `intended and this gate's constant has to move with it — in the same commit, alongside the ` +
          `docblock in the entry file \`${entry}\` is emitted from and the one in ` +
          `\`packages/core/tsconfig.build.json\`, both of which quote the same number.`,
      );

    const bearing = [...closure]
      .filter((file) => graph.has(file))
      .map((file) => [file, networkPrimitivesIn(readFileSync(join(pkg, file), "utf8"))])
      .filter(([, primitives]) => primitives.length > 0);

    if (bearing.length !== expected.networkBearingModules)
      fail(
        `the \`${subpath}\` entry's closure names a network primitive in ${bearing.length} module(s), and ` +
          `ENTRY_CLOSURES says ${expected.networkBearingModules}` +
          (bearing.length > 0 ? ` — ${bearing.map(([f, p]) => `${f} (${p.join(", ")})`).join(", ")}` : "") +
          `. ${
            expected.networkBearingModules === 0
              ? `\`${subpath}\` is the entry whose docblock claims its value-edge closure reaches no ` +
                `\`fetch\`/\`WebSocket\`/\`XMLHttpRequest\`/\`EventSource\` at all, and the downstream ` +
                `extension asserts exactly that for four of its five entry points. A module here is that ` +
                `claim going false. Put the code on \`./job-search\` instead.`
              : `That entry is network-BEARING on purpose, so a DROP is the suspicious direction: it means ` +
                `an adapter fell out of the closure, not that anything got safer.`
          }`,
      );
  }

  // Disjointness, pairwise. Two entries today, so this is one comparison — but
  // written as a sweep because the failure a third entry would introduce is
  // exactly the one nobody would think to look for.
  const walked = [...closures.entries()];
  for (let i = 0; i < walked.length; i += 1) {
    for (let j = i + 1; j < walked.length; j += 1) {
      const [leftPath, left] = walked[i];
      const [rightPath, right] = walked[j];
      const shared = [...left].filter((file) => right.has(file));
      if (shared.length > 0)
        fail(
          `the \`${leftPath}\` and \`${rightPath}\` closures share ${shared.length} module(s) — ` +
            `${shared.slice(0, 5).join(", ")}. They are asserted DISJOINT: that is what makes importing ` +
            `one unable to pull the other in, and what lets \`.\`'s network-free claim survive the ` +
            `existence of a fetching sibling rather than merely sit next to it.`,
        );
    }
  }
}

/**
 * 7. The three lists of published subpaths agree: `exports` in the manifest,
 *    `EXPECTED_EXPORTS`, and `ENTRY_CLOSURES`.
 *
 * WITHOUT THIS THE GATE IS PARTLY VACUOUS, and that was live. Assertions 1, 4, 5
 * and 6 read their subpaths OFF the manifest, so they follow a new entry
 * automatically. Assertion 2 reads `EXPECTED_EXPORTS`, which is hand-written. So
 * a subpath added to `exports` and to nothing else published an entirely
 * unreviewed export surface with the gate green — reproduced by adding
 * `"./sneaky"` and changing nothing else: `✓ … 29 export(s) across 3 entry
 * point(s)`. It COUNTED the new entry, typechecked nothing for it, and asserted
 * nothing about its published names.
 *
 * Set equality in every direction is the fix, and it has to be every direction:
 * a stale row left in either hand-written table after an entry is withdrawn
 * makes that table's assertion silently cover a surface that no longer exists.
 */
function checkPublishedSubpaths(published, fail) {
  const tables = [
    ["EXPECTED_EXPORTS", Object.keys(EXPECTED_EXPORTS)],
    ["ENTRY_CLOSURES", Object.keys(ENTRY_CLOSURES)],
  ];

  for (const [name, gated] of tables) {
    const ungated = published.filter((subpath) => !gated.includes(subpath));
    if (ungated.length > 0)
      fail(
        `\`exports\` publishes ${ungated.map((s) => `"${s}"`).join(", ")}, which ${name} does not name. ` +
          `Nothing else in this gate would notice: an entry point is a published API surface, and this ` +
          `one would ship with no assertion about ` +
          `${name === "EXPECTED_EXPORTS" ? "the names it exports" : "the modules and network primitives its closure reaches"}. ` +
          `A third entry point needs all of:\n    ${THIRD_ENTRY_CHECKLIST.join("\n    ")}`,
      );

    const stale = gated.filter((subpath) => !published.includes(subpath));
    if (stale.length > 0)
      fail(
        `${name} names ${stale.map((s) => `"${s}"`).join(", ")}, which \`exports\` does not publish. ` +
          `That row asserts nothing — drop it, or restore the \`exports\` entry it was written for.`,
      );
  }
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
function checkDeclaredDependencies(declared, graph, entries, fail) {
  // Without this the walk starts nowhere, reaches nothing, and reports every
  // declared dependency as surplus — a confident wrong answer rather than a
  // failure. `exports` moving is exactly the change that would cause it.
  const missing = entries.filter((entry) => !graph.has(entry));
  if (missing.length > 0) {
    fail(
      `${missing.length} entr${missing.length === 1 ? "y" : "ies"} \`exports\` points at ` +
        `(${missing.join(", ")}) ${missing.length === 1 ? "is" : "are"} not among the shipped ` +
        `modules this gate parsed.`,
    );
    return;
  }

  // The UNION across every entry point, because `dependencies` is one list for
  // the whole package: a package imported only from `./job-search` is still
  // required, and judging `.` alone would report it as surplus and tell the
  // reader to delete it.
  const required = new Set();
  const seen = new Set(entries);
  for (const queue = [...entries]; queue.length > 0; ) {
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

/**
 * 2. Runtime: the exact export set PER SUBPATH, behaviour behind three of the
 *    names, and the subpaths `exports` must refuse.
 */
function checkRuntimeSurface(probe, fail) {
  for (const [subpath, expected] of Object.entries(EXPECTED_EXPORTS)) {
    const actual = probe.exports[subpath] ?? [];
    const missing = expected.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !expected.includes(name));
    if (missing.length > 0) fail(`\`${subpath}\` is missing export(s): ${missing.join(", ")}`);
    if (unexpected.length > 0)
      fail(
        `\`${subpath}\` exports name(s) this gate does not know about: ${unexpected.join(", ")}. ` +
          `If that is intended, add them to EXPECTED_EXPORTS in the same commit — a published ` +
          `export is a promise, and WHICH subpath carries it is part of it: \`./job-search\` is ` +
          `the network-bearing entry and \`.\` is the one consumers audit for reaching no \`fetch\`.`,
      );
  }

  // Behaviour, not shape. `deriveJobId` canonicalising the URL is the whole
  // reason `docs/job-capture-contract.md` tells producers to use it rather than
  // roll their own: a copy that keeps `utm_source` forks the id space and turns
  // every re-capture into a duplicate row.
  if (probe.jobId !== "job:ex.com/j/1")
    fail(`deriveJobId() returned ${JSON.stringify(probe.jobId)} through the tarball, expected "job:ex.com/j/1"`);
  if (probe.maxStars !== 5) fail(`MAX_STARS is ${JSON.stringify(probe.maxStars)} through the tarball, expected 5`);

  // The keyless set, in display order — `search.ts`'s fan-out and every
  // consumer's default poll are the same three feeds. An adapter silently
  // dropping out of the registry is a search that quietly returns less.
  const keyless = (probe.keylessIds ?? []).join(", ");
  if (keyless !== "remotive, arbeitnow, jobicy")
    fail(
      `getProviders() answered [${keyless}] through the tarball, expected ` +
        `[remotive, arbeitnow, jobicy] — the always-on keyless set, in display order.`,
    );

  // What `exports` REFUSES, which is the other half of what it publishes. See
  // UNEXPORTED_SUBPATHS: the tarball's unreachable dead JS is only harmless
  // because none of it can be loaded by name.
  //
  // The KEY SET is asserted before the loop, and that is not belt-and-braces.
  // `Object.entries(probe.blocked ?? {})` iterates zero times and passes if
  // `blocked` is ever absent from the probe's output — while the success line
  // below still prints "3 unexported subpath(s) refused". This is the same
  // vacuity class the probe already had once (it built `blocked` and never
  // emitted it), moved one layer up, where the emit is guarded by nothing.
  // `probe.exports` and `probe.keylessIds` are structurally protected — a
  // missing export set fails as missing names, a missing id list as the wrong
  // provider order — and `blocked` is the one field where ABSENT and PASS are
  // the same outcome. A count alone would not do it either: three refusals for
  // three specifiers nobody asked about would satisfy it.
  const reported = Object.keys(probe.blocked ?? {}).sort();
  const requested = [...UNEXPORTED_SUBPATHS].sort();
  if (reported.join("\u0000") !== requested.join("\u0000"))
    fail(
      `the probe reported refusal outcomes for [${reported.join(", ")}], expected exactly the ` +
        `${UNEXPORTED_SUBPATHS.length} subpath(s) in UNEXPORTED_SUBPATHS [${requested.join(", ")}]. ` +
        `An absent or partial \`blocked\` makes the loop below iterate over nothing and pass, so the ` +
        `refusals have to be counted by name before they are judged.`,
    );

  for (const [specifier, outcome] of Object.entries(probe.blocked ?? {})) {
    if (outcome !== "ERR_PACKAGE_PATH_NOT_EXPORTED")
      fail(
        `importing "${specifier}" gave ${outcome}, expected ERR_PACKAGE_PATH_NOT_EXPORTED. ` +
          `\`exports\` must name every published subpath explicitly and carry no wildcard — a ` +
          `\`"./*"\` entry publishes every emitted module, the unreachable dead JS included.`,
      );
  }
}

/** 4. No relative specifier survives any declaration bundle. */
function checkDeclarationBundle(name, dts, fail) {
  const relative = [...dts.matchAll(/\bfrom\s*["'](\.[^"']*)["']/g)].map((m) => m[1]);
  if (relative.length > 0)
    fail(
      `${name} still imports ${relative.length} relative specifier(s) — ${[...new Set(relative)].slice(0, 5).join(", ")}. ` +
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

    // The load-bearing step: ONLY the declared dependencies, and they come from
    // the repo's install rather than the registry so this stays offline.
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const declared = Object.keys(manifest.dependencies ?? {});
    // Read off `exports` rather than hardcoded, so repointing or adding an entry
    // moves what assertions 1, 4 and 5 look at instead of silently leaving it
    // behind. Every subpath is a published surface and each gets the same
    // treatment; the map's shape is asserted here too, since an entry missing
    // `default` or `types` would otherwise quietly drop out of all three.
    const subpaths = Object.entries(manifest.exports ?? {});
    if (subpaths.length === 0) fail("the tarball's `exports` map is empty — nothing is published.");
    const entries = [];
    const declarationEntries = [];
    // Keyed by subpath as well as listed, because assertion 6 judges each
    // closure against the row `ENTRY_CLOSURES` holds for THAT subpath — a
    // positional list would silently pair the wrong numbers with the wrong entry
    // the first time `exports` is reordered.
    const entryFor = new Map();
    for (const [subpath, target] of subpaths) {
      if (typeof target?.default !== "string" || typeof target?.types !== "string") {
        fail(`the \`exports\` entry for "${subpath}" is missing a string \`default\` or \`types\`.`);
        continue;
      }
      entries.push(posix.normalize(target.default));
      declarationEntries.push(posix.normalize(target.types));
      entryFor.set(subpath, posix.normalize(target.default));
    }

    // Before anything reads the hand-written tables: they have to be about the
    // same set of subpaths `exports` publishes, or the assertions that follow
    // cover a subset of the surface while reporting on all of it.
    checkPublishedSubpaths([...entryFor.keys()], fail);

    const graph = checkTarballShape(shipped, pkg, declarationEntries, fail);
    checkDeclaredDependencies(declared, graph, entries, fail);
    checkEntryClosures(graph, pkg, entryFor, fail);
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
    for (const declaration of declarationEntries)
      checkDeclarationBundle(declaration, readFileSync(join(pkg, declaration), "utf8"), fail);

    if (failures.length === 0) {
      const exportCount = Object.values(EXPECTED_EXPORTS).reduce((n, names) => n + names.length, 0);
      // Every number here is one an assertion above just proved. The closure
      // line is spelled out per entry rather than summed because the whole point
      // of the split is WHICH entry reaches a `fetch`, and a total would hide it.
      const closureLine = Object.entries(ENTRY_CLOSURES)
        .map(([subpath, { modules, networkBearingModules }]) => `${subpath} ${modules} modules/${networkBearingModules} fetching`)
        .join(", ");
      console.log(
        `✓ ${PKG_NAME} is publishable: ${shipped.length} file(s) packed, ` +
          `${exportCount} export(s) across ${entries.length} entry point(s) imported under plain ` +
          `Node with only ${declared.length === 0 ? "no" : declared.join(", ")} ` +
          `dependenc${declared.length === 1 ? "y" : "ies"} present, ` +
          `${UNEXPORTED_SUBPATHS.length} unexported subpath(s) refused, disjoint value-edge closures ` +
          `(${closureLine}), and a \`nodenext\` consumer ` +
          `typechecks against ${declarationEntries.join(" + ")} with skipLibCheck off.`,
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

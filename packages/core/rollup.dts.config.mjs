// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Declaration bundler for `@offlinecv/core` (#772).
 *
 * This step exists to work around one specific TypeScript behaviour, and it is
 * worth naming precisely so nobody deletes it as redundant with `tsc`.
 *
 * `tsconfig.build.json` sets `rewriteRelativeImportExtensions`, which rewrites
 * this repo's explicit `./foo.ts` specifiers to `./foo.js` — but **only in the
 * JavaScript output**. Verified on TypeScript 5.8.3, under both
 * `moduleResolution: "bundler"` and `"nodenext"`: the generated `.d.ts` keeps
 * the `.ts` specifier verbatim. The tarball ships no `.ts` files (see `files`
 * in package.json), so a consumer typechecking against a plain per-file `.d.ts`
 * tree would chase `./crud.ts` into a file that is not there and fall back to
 * `any` — or, with `skipLibCheck: false`, simply fail.
 *
 * Bundling the declarations erases the problem rather than patching it: every
 * internal specifier is inlined, so the published `dist/index.d.ts` has no
 * relative imports left to resolve. `check:core` asserts exactly that, plus a
 * `nodenext` consumer typecheck with `skipLibCheck: false` — the configuration
 * a plain Node consumer actually uses, and the one that regresses first if this
 * step is removed.
 *
 * `idb` stays external because it is a real runtime dependency the consumer
 * installs (see `dependencies` in package.json); inlining a third party's types
 * into our surface would fork them at our version.
 *
 * Licensing, recorded deliberately rather than discovered later: this repo vets
 * OSS licenses before adopting a dependency, and `rollup-plugin-dts` is
 * **LGPL-3.0-only** — the only non-permissive license anywhere near this build.
 * It is a build-time `devDependency` that reads `.d.ts` files and writes one
 * back out; nothing of it is linked, bundled or otherwise carried into the
 * emitted artifact, so the tarball stays cleanly Apache-2.0. Anything that
 * changed that — a runtime helper injected into the output, say — would make it
 * a licensing decision rather than a tooling one.
 */

import dts from "rollup-plugin-dts";

/**
 * One bundle per entry point in `package.json`'s `exports`, and the two are a
 * set that has to be kept in step by hand: an entry with no bundle here ships a
 * `types` path the tarball does not contain, which `check:core`'s assertion 1
 * fails at pack time rather than a consumer discovering it as silent `any`.
 *
 * They are separate bundles rather than one with two outputs because they are
 * two independent declaration graphs — `job-search` is the network-bearing
 * subpath and shares only `JobPosting` with `.`. `rollup-plugin-dts` inlines
 * that shared type into both, which is correct: a `.d.ts` describes a surface,
 * and duplicating a structural type across two surfaces costs a consumer
 * nothing at runtime and keeps either bundle readable on its own.
 *
 * The input paths carry the `packages/core/src` nesting because `rootDir` has
 * to cover the `../../../src/lib/…` closure both entries re-export through.
 */
const entries = [
  ["dist/packages/core/src/index.d.ts", "dist/index.d.ts"],
  ["dist/packages/core/src/job-search.d.ts", "dist/job-search.d.ts"],
];

export default entries.map(([input, file]) => ({
  input,
  output: { file, format: "es" },
  external: ["idb"],
  plugins: [dts()],
}));

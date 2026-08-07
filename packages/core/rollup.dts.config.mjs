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

export default {
  // The per-file declaration tree `tsc -p tsconfig.build.json` emits. The path
  // carries the `packages/core/src` nesting because `rootDir` has to cover the
  // `../../../src/lib/…` closure the barrel re-exports through.
  input: "dist/packages/core/src/index.d.ts",
  output: { file: "dist/index.d.ts", format: "es" },
  external: ["idb"],
  plugins: [dts()],
};

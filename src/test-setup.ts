// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Project-wide vitest setup (wired as `test.setupFiles` in `vite.config.ts`).
 *
 * Installs a fresh in-memory `localStorage` shim globally. The `ocv_*`
 * functional keys touch a `localStorage` that neither the Node env (default)
 * provisions nor Node 22+'s built-in global exposes as a working `Storage`
 * (#398) — without `--localstorage-file`, that built-in is an accessor whose
 * getter yields no usable `Storage`, so `.clear`/`.setItem` are absent.
 *
 * It is installed at TWO points, and both are load-bearing:
 *
 *   1. **Module scope**, below. A setup file is evaluated before the test
 *      file's own module body, so this is the only hook that runs early enough
 *      to be seen by a suite reading `localStorage` at import time. #779: the
 *      `beforeEach` alone was not enough. `letter-egress-ack.test.ts` captures
 *      `Object.getOwnPropertyDescriptor(globalThis, "localStorage")` at module
 *      scope in order to restore it later — a reasonable thing for a suite that
 *      swaps the global to simulate hostile storage. With only the `beforeEach`
 *      below, that capture happened first and so captured Node's *built-in*
 *      accessor; the suite's own `afterEach` then restored that accessor over
 *      the working shim, and the next `localStorage.clear()` threw. Green on
 *      CI's Node 20, red on Node 22+ locally — i.e. it read as a broken `main`.
 *   2. **`beforeEach`**, so each test starts from clean persisted state without
 *      any `clear()` bookkeeping, and so a test that deliberately swapped the
 *      global gets a working one back.
 *
 * Doing this at the workload level — instead of an `import + beforeEach` per
 * file — is what keeps a *new* suite from reintroducing the class. #398 fixed
 * it per-file and it recurred in a file written afterwards; the module-scope
 * install is what makes the import-time case unreachable too.
 */

import { beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installMemoryLocalStorage } from "./hooks/__test-utils__/memory-storage.ts";

// Resolved once at module scope, with Node's own `fileURLToPath` + `path.join`
// rather than `new URL(relative, import.meta.url)` — under
// `@vitest-environment jsdom`, jsdom's `URL` implementation mis-resolves a
// multi-segment relative against a `file://` base (drops the project-root
// prefix), which silently ENOENTs the font shim below and falls back to
// Helvetica. `import.meta.url` itself resolves correctly in both envs; only
// the relative-URL join is jsdom's bug, so this sidesteps it entirely.
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets/fonts");

// Before any test file's module body — see (1) above.
installMemoryLocalStorage();

/**
 * Serve the vendored Liberation Sans TTFs to `render-ats-pdf.ts` from disk, so export
 * tests measure the font PRODUCTION ACTUALLY EMBEDS.
 *
 * The renderer fetches its font bytes from a Vite `?url` specifier, which
 * resolves to a root-relative path ("/src/assets/fonts/LiberationSans-Regular.ttf").
 * Node's `fetch` cannot parse that as a URL, so every render in the test suite
 * threw, hit `loadFonts`' catch-all, and silently fell back to the built-in
 * Helvetica. That fallback is a REAL production path (it is what a user gets
 * when the font asset 404s), but it is the rare one — and the embedded font and
 * Helvetica do not share metrics.
 *
 * So every layout assertion in this repo was calibrated against a font that was
 * not the shipped one: wrap points, page breaks, and the fixture
 * strings hand-tuned to wrap to an exact line count all encoded Helvetica
 * metrics. Anything measured about pagination was measured about a document
 * users never receive. Restoring the real bytes here is what makes an export
 * test's "this wraps to three lines" claim true of the actual download.
 *
 * Only the two font assets are intercepted; every other request delegates to the
 * real `fetch`, so a suite that stubs `fetch` for its own purposes is unaffected.
 * Reinstalled per-test (like the storage shim above) because a suite that calls
 * `vi.unstubAllGlobals()` would otherwise strip it for everything after it.
 */
function installBodyFontFetch() {
  const previous = globalThis.fetch;
  // Idempotent: never wrap a wrapper we already installed.
  if ((previous as { __ocvFontShim?: boolean } | undefined)?.__ocvFontShim) return;
  const shim = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // `String()` covers all three `RequestInfo | URL` shapes: a string is itself,
    // a URL stringifies to its href, and a Request is unwrapped to `.url` first.
    const url = String(input instanceof Request ? input.url : input);
    const match = /LiberationSans-(Regular|Bold)\.ttf/.exec(url);
    if (!match) return previous(input, init);
    const path = join(FONTS_DIR, `LiberationSans-${match[1]}.ttf`);
    return new Response(new Uint8Array(readFileSync(path)), { status: 200 });
  }) as typeof fetch & { __ocvFontShim?: boolean };
  shim.__ocvFontShim = true;
  globalThis.fetch = shim;
}

installBodyFontFetch();

beforeEach(() => {
  installMemoryLocalStorage();
  installBodyFontFetch();
});

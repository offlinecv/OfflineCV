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
import { installMemoryLocalStorage } from "./hooks/__test-utils__/memory-storage.ts";

// Before any test file's module body — see (1) above.
installMemoryLocalStorage();

beforeEach(() => {
  installMemoryLocalStorage();
});

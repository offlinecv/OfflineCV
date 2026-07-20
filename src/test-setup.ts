// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Project-wide vitest setup (wired as `test.setupFiles` in `vite.config.ts`).
 *
 * Installs a fresh in-memory `localStorage` shim before EVERY test, globally.
 * The `rl_*` functional keys touch a `localStorage` that neither the Node env
 * (default) provisions nor Node 22+'s built-in global exposes as a working
 * `Storage` (#398). Doing this once at the workload level — instead of an
 * `import + beforeEach` per file — closes the "new test forgot to install the
 * shim" regression class permanently. Per-test-fresh state means suites still
 * start clean without any `clear()` bookkeeping.
 */

import { beforeEach } from "vitest";
import { installMemoryLocalStorage } from "./hooks/__test-utils__/memory-storage.ts";

beforeEach(() => {
  installMemoryLocalStorage();
});

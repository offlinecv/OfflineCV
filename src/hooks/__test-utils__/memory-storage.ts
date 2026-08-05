// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * In-memory `Storage` shim for hook tests that persist to `localStorage`.
 *
 * Two environments need it:
 *  - **Node env** (vitest's default per `vite.config.ts`), where `localStorage`
 *    simply isn't defined.
 *  - **jsdom env**, where Node 22+ ships a *built-in* global `localStorage` that
 *    (without `--localstorage-file`) exposes no working `Storage` — `.clear`/
 *    `.setItem` are absent — and, being a non-configurable global, shadows
 *    jsdom's own `window.localStorage` (`globalThis.localStorage ===
 *    window.localStorage`). A bare `localStorage.clear()` then throws on newer
 *    runtimes: green on CI's Node 20, red on Node 25 locally (#398).
 *
 * `installMemoryLocalStorage()` in a `beforeEach` gives every suite a real,
 * per-test-fresh `Storage` regardless of the underlying runtime.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

/**
 * Replace the global `localStorage` with a fresh in-memory shim and return it.
 * Call in `beforeEach` so each test starts from clean persisted state.
 *
 * Defines the property rather than assigning it, because assignment is only
 * valid when the *current* descriptor happens to permit it, and this runs after
 * arbitrary other suites in the same worker. A test that swaps `localStorage`
 * via `Object.defineProperty` — to fake private-mode throws, or a hostile
 * getter — can leave behind either a non-writable data property or a
 * getter-only accessor, and a plain assignment throws on both ("Cannot assign
 * to read only property" / "which has only a getter"). That surfaces as a
 * failure in the *next* file to run in that worker, which is why it presents as
 * a rare flake in an unrelated suite. `defineProperty` with an explicit
 * `writable`/`configurable` overwrites either shape unconditionally.
 */
export function installMemoryLocalStorage(): Storage {
  const storage = new MemoryStorage() as unknown as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return storage;
}

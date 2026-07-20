// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * usePersistentFlag / usePersistentCounter — thin localStorage-backed hooks.
 *
 * Both are SSR-safe (guards `typeof window`) and fail-silent: any
 * `localStorage` access that throws (private/incognito mode, quota exceeded)
 * falls back to the supplied default and swallows the error — the calling
 * component sees the default and continues normally.
 *
 * usePersistentFlag(key, default) → [value: string, setValue]
 *   Reads/writes a single string value (use "1" / "" for boolean flags).
 *
 * usePersistentCounter(key) → [count: number, increment]
 *   Reads an integer counter; increment() adds 1 (no-op when localStorage
 *   throws — count stays at in-memory value so the UI degrades gracefully).
 */

import { useState } from "react";

// ── Shared localStorage helpers ───────────────────────────────────────────────

function lsGet(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  } catch {
    // Fail silent — quota / private mode / security error.
  }
}

// ── usePersistentFlag ─────────────────────────────────────────────────────────

/**
 * Returns `[value, setValue]` where `value` is a string read from
 * `localStorage[key]`, defaulting to `defaultValue` when the key is absent or
 * localStorage is unavailable.
 *
 * `setValue` writes through to localStorage immediately and updates the
 * in-memory state so the component re-renders.
 */
export function usePersistentFlag(
  key: string,
  defaultValue: string = "",
): [string, (v: string) => void] {
  const [value, setInMemory] = useState<string>(() => {
    const stored = lsGet(key);
    return stored !== null ? stored : defaultValue;
  });

  const setValue = (v: string) => {
    lsSet(key, v);
    setInMemory(v);
  };

  return [value, setValue];
}

// ── usePersistentCounter ──────────────────────────────────────────────────────

/**
 * Returns `[count, increment]` where `count` is an integer read from
 * `localStorage[key]` (defaults to 0). `increment()` adds 1 and writes back.
 */
export function usePersistentCounter(key: string): [number, () => void] {
  const [count, setInMemory] = useState<number>(() => {
    const stored = lsGet(key);
    if (stored === null) return 0;
    const n = parseInt(stored, 10);
    return isNaN(n) ? 0 : n;
  });

  const increment = () => {
    const next = count + 1;
    lsSet(key, String(next));
    setInMemory(next);
  };

  return [count, increment];
}

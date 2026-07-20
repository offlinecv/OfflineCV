// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Cross-instance "at most one section rewrite running at a time" lock.
 *
 * Section rewrite renders one button per RoleEntry. Without a shared lock,
 * two roles can fire concurrent `engine.chat.completions.create()` calls on
 * the same shared WebLLM engine (see `loadEngine` in lib/webllm/web-llm.ts) —
 * which is the single bottleneck the lock exists to guard.
 *
 * The state is module-scoped on purpose: every SectionRewrite instance has
 * to see the same counter, and there is no React tree ancestor we'd want to
 * couple the lock to.
 *
 * The atomic acquire/release functions live at module scope so they can be
 * tested directly without a React render harness (the repo's component
 * tests use `renderToStaticMarkup`, which can't drive effects). The hook is
 * a thin subscription wrapper that re-renders consumers when the counter
 * flips.
 *
 * If we ever allow N concurrent rewrites, swap the counter for a semaphore
 * — the consumer API (acquire returns release-or-null) is already
 * semaphore-shaped.
 */

import { useCallback, useEffect, useState } from "react";

let activeRewriteCount = 0;
const lockListeners = new Set<() => void>();

function notifyLockChange(): void {
  for (const listener of lockListeners) listener();
}

/**
 * Try to acquire the lock synchronously. Returns a `release` fn on success,
 * or `null` if the lock was already held — the caller MUST bail on `null`.
 * Check-and-increment happens in the same synchronous turn, so two
 * `onClick` handlers fired in the same batch can never both succeed (which
 * is the real concurrency guarantee; the `disabled` flag on the button
 * only catches the case where React has already re-rendered).
 *
 * The release fn is idempotent — calling it twice does not underflow the
 * counter. Call it in a `finally` to keep the counter from leaking on
 * error or early return.
 */
export function tryAcquireSectionRewriteLock(): (() => void) | null {
  if (activeRewriteCount > 0) return null;
  activeRewriteCount += 1;
  notifyLockChange();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRewriteCount = Math.max(0, activeRewriteCount - 1);
    notifyLockChange();
  };
}

export function isSectionRewriteLocked(): boolean {
  return activeRewriteCount > 0;
}

export interface SectionRewriteLock {
  isLocked: boolean;
  acquire: () => (() => void) | null;
}

export function useSectionRewriteLock(): SectionRewriteLock {
  const [, setTick] = useState(0);
  useEffect(() => {
    const force = () => setTick((t) => t + 1);
    lockListeners.add(force);
    return () => {
      lockListeners.delete(force);
    };
  }, []);
  const acquire = useCallback(tryAcquireSectionRewriteLock, []);
  return { isLocked: isSectionRewriteLocked(), acquire };
}

/** Test-only: drop the counter so each test starts with no held lock. */
export function _resetSectionRewriteLockForTesting(): void {
  activeRewriteCount = 0;
  lockListeners.clear();
}

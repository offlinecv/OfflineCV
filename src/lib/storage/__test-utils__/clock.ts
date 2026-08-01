// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Wall-clock helper shared by the `src/lib/storage/*.test.ts` suites.
 *
 * The stores stamp `updatedAt` from `Date.now()` and several suites assert a
 * newest-first order, so two writes inside the same millisecond leave the sort
 * breaking a tie arbitrarily — the assertion then passes or fails on how fast
 * the machine is. Every storage suite needs the same nudge, so it lives here
 * once rather than being re-derived per file.
 */

/**
 * Resolve once the wall clock has advanced past the current millisecond, so the
 * next write gets a strictly greater `updatedAt` than the previous one.
 *
 * Real timers on purpose: it busy-waits on `Date.now()`, which fake timers
 * would freeze into an infinite loop. A suite that installs them must not use
 * this.
 */
export async function tick(): Promise<void> {
  const started = Date.now();
  while (Date.now() === started) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

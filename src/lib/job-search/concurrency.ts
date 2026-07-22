// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Bounded-concurrency `Promise.allSettled` (#533, slice 5 of the job-search-v2
 * epic #528).
 *
 * The keyless fan-out was three feeds, so `Promise.allSettled(all)` was fine.
 * Company-board search fans out to one provider PER SELECTED COMPANY, and
 * firing every board at once means a dozen simultaneous cross-origin fetches
 * competing for the browser's per-host connection pool — the slowest board
 * gates the whole search and the tab stalls. This runs at most `limit`
 * in flight and starts the next as soon as one settles.
 *
 * Contract deliberately mirrors `Promise.allSettled`: results come back in
 * INPUT INDEX ORDER regardless of completion order (the orchestrator maps a
 * rejected slot back to `providers[i].label` for `degradedProviders`), and the
 * returned promise never rejects — a task's failure is a `rejected` slot.
 */

/**
 * Run `fn` over `items` with at most `limit` concurrent calls. Never rejects;
 * each slot is a `PromiseSettledResult` in the item's original index position.
 * A `limit` below 1 is clamped to 1 (serial) rather than deadlocking on zero
 * workers.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    // Read-then-increment in one synchronous step, so two workers resuming in
    // the same microtask turn can never claim the same index.
    for (let i = cursor++; i < items.length; i = cursor++) {
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `mapWithConcurrency` is the fan-out limiter the company-board search depends
 * on, so these pin the three properties `search.ts` actually relies on: results
 * land in INPUT order (the degraded-provider mapping indexes into it), a
 * rejection is a slot not a throw, and the in-flight count never exceeds the
 * limit.
 */

import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency.ts";

/** Resolve after a macrotask, so interleaving is real rather than microtask-
 *  ordered by luck. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    // Deliberately inverted durations: the last item finishes first.
    const items = [30, 20, 10, 0];
    const settled = await mapWithConcurrency(items, 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(settled.map((s) => (s.status === "fulfilled" ? s.value : null))).toEqual([
      30, 20, 10, 0,
    ]);
  });

  it("never exceeds `limit` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight -= 1;
      return null;
    });
    expect(peak).toBe(3);
  });

  it("records a rejection as a slot and still runs the rest", async () => {
    const settled = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(settled[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(settled[1].status).toBe("rejected");
    expect(settled[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("clamps a limit below 1 to serial instead of deadlocking", async () => {
    let peak = 0;
    let inFlight = 0;
    const settled = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight -= 1;
      return n;
    });
    expect(peak).toBe(1);
    expect(settled).toHaveLength(3);
  });

  it("resolves to an empty array for no items", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

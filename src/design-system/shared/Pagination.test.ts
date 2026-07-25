// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit coverage for `pageWindow` — the only logic in Pagination. Asserts the
 * two properties the control depends on rather than exact strips for their own
 * sake: first and last are ALWAYS reachable, and the rendered slot count stays
 * bounded no matter how many pages exist. Rendering is covered through
 * `JobSearchResults.test.tsx`, its only consumer.
 */

import { describe, it, expect } from "vitest";
import { pageWindow } from "./Pagination.tsx";

describe("pageWindow", () => {
  it("lists every page, gap-free, for a short set", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("elides on the right when the current page is near the start", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 6, null, 20]);
  });

  it("elides on the left when the current page is near the end", () => {
    expect(pageWindow(20, 20)).toEqual([1, null, 15, 16, 17, 18, 19, 20]);
  });

  it("elides on both sides and centres the window mid-set", () => {
    expect(pageWindow(10, 20)).toEqual([1, null, 8, 9, 10, 11, 12, null, 20]);
  });

  it("always keeps first, last, and the current page reachable", () => {
    for (const pageCount of [1, 2, 6, 7, 8, 9, 40, 500]) {
      // Only in-range pages: the caller clamps `page` to [1, pageCount] before
      // rendering, so an out-of-range index is not a contract this must honour.
      const pages = [1, 2, Math.ceil(pageCount / 2), pageCount].filter(
        (p) => p <= pageCount,
      );
      for (const page of pages) {
        const slots = pageWindow(page, pageCount);
        expect(slots).toContain(1);
        expect(slots).toContain(pageCount);
        expect(slots).toContain(page);
        // Bounded strip: 5 windowed slots + first + last + up to 2 ellipses.
        expect(slots.length).toBeLessThanOrEqual(9);
        // Strictly ascending page numbers — no duplicate or out-of-order slot.
        const numbers = slots.filter((s): s is number => s !== null);
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
        expect(new Set(numbers).size).toBe(numbers.length);
      }
    }
  });
});

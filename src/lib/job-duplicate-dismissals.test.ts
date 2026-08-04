// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * "Not the same", remembered (#746). The property that matters is durability
 * across a reload, which here is a fresh read of `localStorage` — the module
 * caches nothing, so a second read IS what the next session sees. The other
 * half is the failure direction: an unusable or corrupt store must read as
 * "nothing dismissed" (ask again), never as "everything dismissed" (silently
 * suppress a merge the user never declined).
 *
 * The `localStorage` shim is installed globally before every test by
 * `src/test-setup.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  dismissJobPair,
  readDismissedJobPairs,
} from "./job-duplicate-dismissals.ts";
import { jobPairKey } from "./job-duplicates.ts";

describe("job-duplicate-dismissals", () => {
  it("starts empty", () => {
    expect(readDismissedJobPairs().size).toBe(0);
  });

  it("remembers a dismissed pairing across a fresh read — the reload case", () => {
    dismissJobPair("a", "b");
    expect(readDismissedJobPairs().has(jobPairKey("a", "b"))).toBe(true);
  });

  it("suppresses the pairing in both directions", () => {
    dismissJobPair("b", "a");
    expect(readDismissedJobPairs().has(jobPairKey("a", "b"))).toBe(true);
  });

  it("does not suppress an unrelated pairing", () => {
    dismissJobPair("a", "b");
    expect(readDismissedJobPairs().has(jobPairKey("a", "c"))).toBe(false);
  });

  it("is idempotent — dismissing twice stores one entry", () => {
    dismissJobPair("a", "b");
    dismissJobPair("a", "b");
    expect(readDismissedJobPairs().size).toBe(1);
  });

  it("accumulates rather than replacing", () => {
    dismissJobPair("a", "b");
    dismissJobPair("c", "d");
    expect(readDismissedJobPairs().size).toBe(2);
  });

  it("reads a corrupt value as nothing dismissed, so it re-asks rather than suppressing", () => {
    globalThis.localStorage.setItem("offlinecv:jobs:not-duplicates", "{not json");
    expect(readDismissedJobPairs().size).toBe(0);
  });

  it("ignores non-string entries in an otherwise readable list", () => {
    globalThis.localStorage.setItem(
      "offlinecv:jobs:not-duplicates",
      JSON.stringify([jobPairKey("a", "b"), 42, null]),
    );
    expect([...readDismissedJobPairs()]).toEqual([jobPairKey("a", "b")]);
  });

  it("fails silent when the store refuses a write, and does not claim the suppression", () => {
    const setItem = vi
      .spyOn(globalThis.localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    expect(() => dismissJobPair("a", "b")).not.toThrow();
    setItem.mockRestore();
    expect(readDismissedJobPairs().size).toBe(0);
  });
});

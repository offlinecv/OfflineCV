// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for `removeAddedBulletLine` (#637) — the splice that makes removing a
 * user-added bullet real.
 *
 * The identity contract is the load-bearing one: the caller distinguishes
 * "spliced" from "no such line" by reference, and that distinction is what
 * decides whether a removal falls through to the observation-indexed
 * `removedBullets` path.
 */

import { describe, it, expect } from "vitest";
import { removeAddedBulletLine } from "./added-bullets.ts";

describe("removeAddedBulletLine", () => {
  it("splices the matching line out of the entry's bucket", () => {
    const before = { "added:0": ["First line", "Second line", "Third line"] };
    const after = removeAddedBulletLine(before, "added:0", "Second line");
    expect(after["added:0"]).toEqual(["First line", "Third line"]);
    // The input is never mutated.
    expect(before["added:0"]).toHaveLength(3);
  });

  it("DELETES an emptied bucket rather than leaving `{key: []}`", () => {
    const after = removeAddedBulletLine(
      { "added:0": ["Only line"] },
      "added:0",
      "Only line",
    );
    // `hasEdits` keys off Object.keys(addedBullets).length, so a stray empty
    // bucket would leave the résumé permanently "dirty" after the removal.
    expect("added:0" in after).toBe(false);
    expect(Object.keys(after)).toHaveLength(0);
  });

  it("leaves sibling buckets untouched", () => {
    const after = removeAddedBulletLine(
      { "added:0": ["Gone"], "experience:2": ["Kept"] },
      "added:0",
      "Gone",
    );
    expect(after).toEqual({ "experience:2": ["Kept"] });
  });

  it("matches on the normalised form (marker, case, inner whitespace)", () => {
    const after = removeAddedBulletLine(
      { "added:0": ["Cut  p99 latency by 38%"] },
      "added:0",
      "• cut p99 latency by 38%",
    );
    expect("added:0" in after).toBe(false);
  });

  it("removes only the FIRST of two identical lines", () => {
    const after = removeAddedBulletLine(
      { "added:0": ["Same", "Same", "Other"] },
      "added:0",
      "Same",
    );
    expect(after["added:0"]).toEqual(["Same", "Other"]);
  });

  it("returns the input BY REFERENCE when the bucket is absent", () => {
    const before = { "added:0": ["Present"] };
    expect(removeAddedBulletLine(before, "added:9", "Present")).toBe(before);
  });

  it("returns the input BY REFERENCE when no line matches", () => {
    const before = { "added:0": ["Present"] };
    expect(removeAddedBulletLine(before, "added:0", "Absent")).toBe(before);
  });
});

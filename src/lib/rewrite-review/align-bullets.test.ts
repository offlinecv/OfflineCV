// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  alignBullets,
  bulletSimilarity,
  MATCH_THRESHOLD,
  type AlignedPair,
} from "./align-bullets.ts";

/** Compact a pair list to a readable shape for assertions. */
function shape(pairs: AlignedPair[]): string[] {
  return pairs.map((p) => {
    if (p.kind === "matched") return `M ${p.originalIndex}->${p.proposedIndex}`;
    if (p.kind === "added") return `A ${p.proposedIndex}`;
    return `D ${p.originalIndex}`;
  });
}

describe("bulletSimilarity", () => {
  it("scores identical bullets as 1", () => {
    expect(bulletSimilarity("Led the team", "Led the team")).toBe(1);
  });

  it("ignores casing, whitespace, and a leading bullet marker", () => {
    expect(bulletSimilarity("• Led  the   team", "led the team")).toBe(1);
  });

  it("scores disjoint bullets as 0", () => {
    expect(bulletSimilarity("Cooked dinner", "Filed taxes")).toBe(0);
  });

  it("two empty bullets are identical, one empty is 0", () => {
    expect(bulletSimilarity("", "")).toBe(1);
    expect(bulletSimilarity("", "anything")).toBe(0);
  });

  it("a reworded bullet scores partially (between 0 and 1)", () => {
    const s = bulletSimilarity(
      "Built a dashboard for sales",
      "Built an analytics dashboard for the sales team",
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("counts repeated words by min occurrence (multiset, not set)", () => {
    // "the the" vs "the" — overlap is 1 (min), not 2.
    const s = bulletSimilarity("the the", "the");
    // 2*1 / (2 + 1) = 0.666…
    expect(s).toBeCloseTo(2 / 3, 5);
  });
});

describe("alignBullets — degenerate inputs", () => {
  it("both empty → []", () => {
    expect(alignBullets([], [])).toEqual([]);
  });

  it("empty original → all additions in order", () => {
    expect(shape(alignBullets([], ["a", "b"]))).toEqual(["A 0", "A 1"]);
  });

  it("empty proposed → all removals in order", () => {
    expect(shape(alignBullets(["a", "b"], []))).toEqual(["D 0", "D 1"]);
  });
});

describe("alignBullets — 1:1 and edits", () => {
  it("aligns identical lists 1:1", () => {
    const pairs = alignBullets(["one", "two", "three"], ["one", "two", "three"]);
    expect(shape(pairs)).toEqual(["M 0->0", "M 1->1", "M 2->2"]);
  });

  it("pairs a lightly-reworded bullet as a match, not add+remove", () => {
    const pairs = alignBullets(
      ["Managed a team of 5 engineers"],
      ["Managed a team of 5 senior engineers"],
    );
    expect(shape(pairs)).toEqual(["M 0->0"]);
  });
});

describe("alignBullets — M ≠ N", () => {
  it("more proposed than original → matches + a trailing addition", () => {
    const pairs = alignBullets(
      ["Shipped the API", "Wrote the docs"],
      ["Shipped the API", "Wrote the docs", "Mentored two interns"],
    );
    expect(shape(pairs)).toEqual(["M 0->0", "M 1->1", "A 2"]);
  });

  it("fewer proposed than original → matches + a removal", () => {
    const pairs = alignBullets(
      ["Shipped the API", "Filler line here", "Wrote the docs"],
      ["Shipped the API", "Wrote the docs"],
    );
    expect(shape(pairs)).toEqual(["M 0->0", "D 1", "M 2->1"]);
  });

  it("an unrelated proposed bullet becomes add + remove, not a forced match", () => {
    const pairs = alignBullets(
      ["Optimized the database queries"],
      ["Organized the company picnic"],
    );
    // Below threshold → must NOT be a match.
    expect(pairs.every((p) => p.kind !== "matched")).toBe(true);
    expect(shape(pairs).sort()).toEqual(["A 0", "D 0"]);
  });
});

describe("alignBullets — reordering and duplicates", () => {
  it("reordered bullets still each match exactly one original", () => {
    const original = ["Alpha task done well", "Beta task done well"];
    const proposed = ["Beta task done well", "Alpha task done well"];
    const pairs = alignBullets(original, proposed);
    const matched = pairs.filter((p) => p.kind === "matched");
    // Each original index appears at most once; each proposed index at most once.
    const oIdx = matched.map((p) => (p as { originalIndex: number }).originalIndex);
    const pIdx = matched.map((p) => (p as { proposedIndex: number }).proposedIndex);
    expect(new Set(oIdx).size).toBe(oIdx.length);
    expect(new Set(pIdx).size).toBe(pIdx.length);
  });

  it("duplicate-text originals are each consumed at most once", () => {
    const original = ["Same bullet text", "Same bullet text"];
    const proposed = ["Same bullet text"];
    const pairs = alignBullets(original, proposed);
    const matched = pairs.filter((p) => p.kind === "matched");
    expect(matched).toHaveLength(1);
    const removed = pairs.filter((p) => p.kind === "removed");
    expect(removed).toHaveLength(1);
    // Distinct original indices across match + removal — neither double-used.
    const used = [
      ...matched.map((p) => (p as { originalIndex: number }).originalIndex),
      ...removed.map((p) => (p as { originalIndex: number }).originalIndex),
    ];
    expect(new Set(used).size).toBe(2);
  });
});

describe("alignBullets — invariants", () => {
  it("every original index and every proposed index appears exactly once", () => {
    const original = ["aaa bbb ccc", "ddd eee fff", "ggg hhh iii"];
    const proposed = ["aaa bbb ccc zzz", "brand new bullet", "ggg hhh iii"];
    const pairs = alignBullets(original, proposed);

    const oSeen = new Set<number>();
    const pSeen = new Set<number>();
    for (const p of pairs) {
      if (p.kind === "matched") {
        oSeen.add(p.originalIndex);
        pSeen.add(p.proposedIndex);
      } else if (p.kind === "removed") {
        oSeen.add(p.originalIndex);
      } else {
        pSeen.add(p.proposedIndex);
      }
    }
    expect([...oSeen].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect([...pSeen].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("ids are unique across the pair list", () => {
    const pairs = alignBullets(
      ["one two three", "four five six"],
      ["one two three", "seven eight nine", "four five six"],
    );
    const ids = pairs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("MATCH_THRESHOLD is a sane fraction", () => {
    expect(MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(MATCH_THRESHOLD).toBeLessThan(1);
  });
});

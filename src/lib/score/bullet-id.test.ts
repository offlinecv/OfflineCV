// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  assignBulletIds,
  bulletId,
  bulletIdText,
  isLegacyBulletKey,
  isUnresolvableBulletKey,
} from "./bullet-id.ts";
import { computeAnonymousAtsScore } from "./score.ts";
import type { SectionedResume } from "../heuristics/sections.ts";

describe("bulletId / bulletIdText", () => {
  it("round-trips the normalised text an id names", () => {
    const id = bulletId("• Led   the Team", 0);
    expect(bulletIdText(id)).toBe("led the team");
  });

  it("distinguishes repeated occurrences of the same line", () => {
    expect(bulletId("Shipped it", 0)).not.toBe(bulletId("Shipped it", 1));
    expect(bulletIdText(bulletId("Shipped it", 1))).toBe("shipped it");
  });

  it("survives a `|` inside the bullet text", () => {
    // The separator is the FIRST `|`, and the prefix is always digits.
    expect(bulletIdText(bulletId("Built A | B | C pipelines", 0))).toBe(
      "built a | b | c pipelines",
    );
  });

  it("returns undefined for a key that names no text", () => {
    expect(bulletIdText("7")).toBeUndefined(); // legacy index
    expect(bulletIdText("")).toBeUndefined();
    expect(bulletIdText("0|")).toBeUndefined(); // marker-only line
    expect(bulletIdText("|text")).toBeUndefined(); // no ordinal
    expect(bulletIdText("x|text")).toBeUndefined(); // non-numeric ordinal
  });
});

describe("isLegacyBulletKey", () => {
  it("is true for a bare pre-#648 pool index and false for every id", () => {
    expect(isLegacyBulletKey("0")).toBe(true);
    expect(isLegacyBulletKey("42")).toBe(true);
    expect(isLegacyBulletKey(bulletId("Anything at all", 0))).toBe(false);
    // The load-bearing property: an id ALWAYS carries a separator, so the two
    // key spaces are disjoint and one resolver can serve both.
    expect(isLegacyBulletKey(bulletId("123", 9))).toBe(false);
  });
});

describe("isUnresolvableBulletKey", () => {
  it("is true for an id whose text half is empty", () => {
    // What a pooled marker-only line mints — `"• 4."`, or `"•"` merged with the
    // following `"4."` by the lone-bullet rule (#30). `normalizeBulletText`
    // strips the marker to nothing, so the id carries no text to match on and a
    // removal filed under it is inert and permanent (#660).
    expect(bulletId("4.", 0)).toBe("0|");
    expect(isUnresolvableBulletKey(bulletId("4.", 0))).toBe(true);
    expect(isUnresolvableBulletKey(bulletId("•", 3))).toBe(true);
  });

  it("is FALSE for a legacy pre-#648 pool index", () => {
    // The carve-out, and not a hypothetical: `useEditableParse.replay` funnels a
    // persisted snapshot's `removedBullets` through `removeBullet`, so treating a
    // legacy index as unresolvable silently drops every removal in a saved-library
    // résumé or a localStorage draft as it replays. `resolveOverrideOriginal`
    // resolves these through the frozen base-parse pool.
    expect(isUnresolvableBulletKey("0")).toBe(false);
    expect(isUnresolvableBulletKey("42")).toBe(false);
  });

  it("is false for any id that carries text", () => {
    expect(isUnresolvableBulletKey(bulletId("Shipped it", 0))).toBe(false);
    expect(isUnresolvableBulletKey(bulletId("• Led   the Team", 2))).toBe(false);
  });

  it("is true for a malformed key in neither space", () => {
    // Not reachable from `assignBulletIds`, but these name no line either, so the
    // predicate must not report them resolvable.
    expect(isUnresolvableBulletKey("")).toBe(true);
    expect(isUnresolvableBulletKey("|text")).toBe(true);
    expect(isUnresolvableBulletKey("x|text")).toBe(true);
  });
});

describe("assignBulletIds", () => {
  it("numbers occurrences per normalised text, in pool order", () => {
    expect(assignBulletIds(["Alpha", "Beta", "alpha", "  ALPHA  "])).toEqual([
      "0|alpha",
      "0|beta",
      "1|alpha",
      "2|alpha",
    ]);
  });
});

describe("assignBulletIds allocates AROUND already-claimed keys (#648)", () => {
  it("skips an ordinal an existing override is filed under", () => {
    // The pool that produced `0|alpha` has since been edited, so the surviving
    // twin must NOT re-mint that key — writing to it would overwrite the first
    // edit instead of appending a second instruction.
    expect(assignBulletIds(["Alpha"], ["0|alpha"])).toEqual(["1|alpha"]);
    expect(assignBulletIds(["Alpha"], ["0|alpha", "1|alpha"])).toEqual([
      "2|alpha",
    ]);
  });

  it("allocates around claims AND around ids handed to earlier rows", () => {
    // Two live twins plus one claimed ordinal: three distinct keys, no reuse.
    expect(assignBulletIds(["Alpha", "Alpha"], ["0|alpha"])).toEqual([
      "1|alpha",
      "2|alpha",
    ]);
  });

  it("fills a HOLE left by a non-contiguous claim", () => {
    // Claims are not guaranteed contiguous — editing the second of two twins
    // first claims `1|alpha` and leaves `0|alpha` free. Reusing the free ordinal
    // is correct: resolution is first-match, so the ordinal only has to be
    // unique, never ordered.
    expect(assignBulletIds(["Alpha"], ["1|alpha"])).toEqual(["0|alpha"]);
  });

  it("ignores claims naming a different text, and legacy numeric keys", () => {
    expect(assignBulletIds(["Alpha"], ["0|beta", "3", "17"])).toEqual([
      "0|alpha",
    ]);
  });

  it("is unchanged with no claims (the base-parse grade)", () => {
    expect(assignBulletIds(["Alpha", "alpha"], [])).toEqual([
      "0|alpha",
      "1|alpha",
    ]);
  });
});

describe("the scorer mints ids on every observation", () => {
  function sections(lines: readonly string[]): SectionedResume {
    return {
      byName: new Map([["experience", lines]]) as SectionedResume["byName"],
      accomplishmentSections: ["experience", "projects", "achievements"],
      source: "regex",
    };
  }

  it("is stable across a re-grade that drops an EARLIER bullet", () => {
    // The property the whole rework rests on: removing A must not change what
    // B's and C's keys mean. Under `index` it did — every later bullet shifted.
    const all = ["• Alpha bullet here", "• Beta bullet here", "• Gamma bullet here"];
    const grade = (lines: readonly string[]) =>
      computeAnonymousAtsScore({
        parsed: { full_name: "R", skills: [], experience: [], education: [] },
        fieldConfidence: {},
        triggers: [],
        rawText: lines.join("\n"),
        sections: sections(lines),
      }).bullets ?? [];

    const before = grade(all);
    const after = grade(all.slice(1));

    expect(before.map((b) => b.id).slice(1)).toEqual(after.map((b) => b.id));
    // …while the indices very much did shift, which is why they cannot be keys.
    expect(before.map((b) => b.index).slice(1)).not.toEqual(
      after.map((b) => b.index),
    );
  });
});

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
 *
 * The two #660 blocks at the end cover the read-only halves of the same
 * normalised-key contract: the add-time validator that keeps a line normalising
 * to the EMPTY key out of the bucket, and the text→bucket lookup the one remove
 * path with no `entryKey` needs. Both must agree with the writers above about
 * what "empty" means, which is why all four share `normalizeBulletText`.
 */

import { describe, it, expect } from "vitest";
import {
  findAddedBulletEntry,
  isContentlessBulletLine,
  removeAddedBulletLine,
} from "./added-bullets.ts";

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

  it("picks the RIGHT contentless line out of a bucket holding two", () => {
    // Resolving the correct bucket is not enough on its own: this splice matches
    // by the same rule the resolver does, so on the empty normalised key it would
    // have taken whichever contentless line came first.
    const after = removeAddedBulletLine(
      { "added:0": ["1.", "Real bullet here", "4."] },
      "added:0",
      "4.",
    );
    expect(after["added:0"]).toEqual(["1.", "Real bullet here"]);
  });

  it("leaves a contentless line alone when a DIFFERENT one was named", () => {
    const before = { "added:0": ["1."] };
    expect(removeAddedBulletLine(before, "added:0", "4.")).toBe(before);
  });
});

// ── #660: the empty normalised key ────────────────────────────────────────────

describe("isContentlessBulletLine", () => {
  it("rejects a line that is nothing but a bullet glyph", () => {
    for (const marker of ["•", "-", "*", "–", "·", "‣", "●", "▪", "◦", "▶"]) {
      expect(isContentlessBulletLine(marker)).toBe(true);
    }
  });

  it("rejects a line that is nothing but a NUMBERED marker", () => {
    // The reachable half of the defect: unlike a lone glyph, a lone "1." carries
    // a `\p{N}`, so `countWords` counts it and the scorer POOLS it — which is
    // what put a row on screen under "Other bullets" (#660).
    for (const marker of ["1.", "2)", "10)", "07."]) {
      expect(isContentlessBulletLine(marker)).toBe(true);
    }
  });

  it("rejects blank and whitespace-only text", () => {
    expect(isContentlessBulletLine("")).toBe(true);
    expect(isContentlessBulletLine("   ")).toBe(true);
    expect(isContentlessBulletLine("   ")).toBe(true);
  });

  it("ACCEPTS a marker-prefixed line that carries content", () => {
    // The trap this predicate must not fall into: `normalizeBulletText` strips a
    // leading marker BY DESIGN, so a guard written as "the raw text contains only
    // marker characters after the strip" would be right, while one written as
    // "the text starts with a marker" would reject every legitimately bulleted
    // line the user pastes in.
    expect(isContentlessBulletLine("• Shipped X")).toBe(false);
    expect(isContentlessBulletLine("- Shipped X")).toBe(false);
    expect(isContentlessBulletLine("1. Shipped X")).toBe(false);
    expect(isContentlessBulletLine("•Shipped X")).toBe(false);
  });

  it("ACCEPTS content that is only a number or a single word", () => {
    // Degenerate-looking but not contentless: a numeral is real text once it is
    // not a list marker, so the guard must key on the normalised form, not on
    // "does this look like prose".
    expect(isContentlessBulletLine("2019")).toBe(false);
    expect(isContentlessBulletLine("Promoted")).toBe(false);
    // A marker mid-line is not a leading marker.
    expect(isContentlessBulletLine("A - B")).toBe(false);
  });
});

describe("findAddedBulletEntry", () => {
  it("finds the bucket holding a normalise-equal line", () => {
    const buckets = {
      "experience:0": ["Cut p99 latency by 38%"],
      "added:3": ["Grew the team from 4 to 11"],
    };
    expect(findAddedBulletEntry(buckets, "Grew the team from 4 to 11")).toBe(
      "added:3",
    );
    expect(findAddedBulletEntry(buckets, "• cut  P99 LATENCY by 38%")).toBe(
      "experience:0",
    );
  });

  it("finds the degenerate line the 'Other bullets' group renders", () => {
    // The whole point: the row's observation text is all the caller has, and it
    // normalises to "" — which still matches, because both sides normalise.
    expect(findAddedBulletEntry({ "experience:0": ["Real bullet", "1."] }, "1.")).toBe(
      "experience:0",
    );
    expect(findAddedBulletEntry({ "added:1": ["•"] }, "•")).toBe("added:1");
  });

  it("returns undefined when no bucket carries the line", () => {
    expect(
      findAddedBulletEntry({ "added:0": ["Something else"] }, "Not here"),
    ).toBeUndefined();
    expect(findAddedBulletEntry({}, "1.")).toBeUndefined();
  });

  it("does NOT match a contentless line against a bucket of real bullets", () => {
    // A degenerate row must not resolve to some unrelated entry just because
    // that entry has a bucket — the normalised keys have to be equal, and a real
    // bullet never normalises to "".
    expect(
      findAddedBulletEntry({ "added:0": ["Shipped a design system"] }, "1."),
    ).toBeUndefined();
  });

  it("returns the FIRST bucket when two carry the line", () => {
    const buckets = { "added:0": ["1."], "added:1": ["1."] };
    expect(findAddedBulletEntry(buckets, "1.")).toBe("added:0");
  });

  it("does NOT match a DIFFERENT contentless line", () => {
    // Two markers, one normalised key (`""`), so the key identifies neither. A
    // resolver keyed on it returned the `"1."` bucket for a `"4."` row — and the
    // splice that followed deleted another role's bullet while reporting success.
    // The verbatim text is what tells them apart.
    expect(findAddedBulletEntry({ "added:0": ["1."] }, "4.")).toBeUndefined();
    expect(findAddedBulletEntry({ "added:0": ["•"] }, "2)")).toBeUndefined();
    // …and the line still resolves from its own row.
    expect(findAddedBulletEntry({ "added:0": ["1."] }, "1.")).toBe("added:0");
  });

  it("ignores an empty bucket", () => {
    expect(
      findAddedBulletEntry({ "added:0": [], "added:1": ["1."] }, "1."),
    ).toBe("added:1");
  });
});

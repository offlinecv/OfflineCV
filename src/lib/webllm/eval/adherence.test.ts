// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the steering-adherence scorer (#608 half 2).
 *
 * The point of this file is the NEGATIVE half. #608's acceptance criterion is
 * explicit — "it **fails** on a deliberately non-compliant output. Prove the
 * scorer bites before trusting its verdict" — because a criterion that always
 * passes is indistinguishable from a criterion that works, right up until it is
 * used to close half 2 as not-reproducible. Every check below is asserted in
 * both directions.
 */

import { describe, expect, it } from "vitest";
import { describeCheck, scoreAdherence } from "./adherence.ts";
import type { AdherenceCheck } from "./types.ts";

const FORBIDDEN: AdherenceCheck = {
  kind: "forbidden-word",
  word: "spearheaded",
};

describe("scoreAdherence — forbidden-word", () => {
  it("passes when the word is absent", () => {
    expect(
      scoreAdherence(FORBIDDEN, [
        "Led the billing migration across 12 markets",
        "Cut scope churn 30% with a quarterly planning process",
      ]),
    ).toBe(true);
  });

  it("FAILS when the model used the forbidden word anyway", () => {
    expect(
      scoreAdherence(FORBIDDEN, [
        "Led the billing migration across 12 markets",
        "Spearheaded a quarterly planning process",
      ]),
    ).toBe(false);
  });

  it("FAILS case-insensitively", () => {
    expect(scoreAdherence(FORBIDDEN, ["SPEARHEADED the rollout"])).toBe(false);
  });

  it("matches on a word boundary, not a substring", () => {
    // "spearheadedness" is not the word the instruction forbade. A substring
    // check would fail a compliant output and understate adherence.
    expect(scoreAdherence(FORBIDDEN, ["Led the spearheadedness review"])).toBe(
      true,
    );
  });

  it("treats regex metacharacters in the word as literal", () => {
    const check: AdherenceCheck = { kind: "forbidden-word", word: "c++" };
    expect(scoreAdherence(check, ["Wrote c++ for the parser"])).toBe(false);
    expect(scoreAdherence(check, ["Wrote Rust for the parser"])).toBe(true);
  });
});

describe("scoreAdherence — max-words", () => {
  const check: AdherenceCheck = { kind: "max-words", limit: 8 };

  it("passes when every bullet is inside the limit", () => {
    expect(
      scoreAdherence(check, ["Led the billing migration", "Cut churn 30%"]),
    ).toBe(true);
  });

  it("FAILS when a single bullet exceeds it", () => {
    expect(
      scoreAdherence(check, [
        "Led the billing migration",
        "Cut scope churn by thirty percent across every planning cycle this year",
      ]),
    ).toBe(false);
  });

  it("passes exactly at the limit", () => {
    expect(scoreAdherence(check, ["one two three four five six seven eight"])).toBe(
      true,
    );
  });

  it("does not count punctuation-only tokens as words", () => {
    // Same rule as the product scorer's `countWords` (#627): a spaced em-dash
    // is not a word. Nine tokens, eight words — must pass at limit 8, or the
    // eval and the app disagree about a bullet on the boundary.
    expect(
      scoreAdherence(check, ["one two three — four five six seven eight"]),
    ).toBe(true);
  });
});

describe("scoreAdherence — distinct-verbs", () => {
  const check: AdherenceCheck = { kind: "distinct-verbs" };

  it("passes when every bullet leads with a different action verb", () => {
    expect(
      scoreAdherence(check, [
        "Led the billing migration",
        "Cut scope churn 30%",
        "Shipped the design system",
      ]),
    ).toBe(true);
  });

  it("FAILS when a verb repeats", () => {
    expect(
      scoreAdherence(check, [
        "Led the billing migration",
        "Led the design system rollout",
      ]),
    ).toBe(false);
  });

  it("normalizes punctuation, so 'Led,' and 'Led' are one verb", () => {
    expect(
      scoreAdherence(check, ["Led, the billing migration", "Led the rollout"]),
    ).toBe(false);
  });

  it("FAILS when a bullet does not lead with an action verb at all", () => {
    // "every bullet leads with a DIFFERENT verb" presupposes verb-leading;
    // distinct non-verbs must not sneak a pass.
    expect(
      scoreAdherence(check, [
        "Responsible for the billing migration",
        "Various design system duties",
      ]),
    ).toBe(false);
  });
});

describe("scoreAdherence — empty output", () => {
  it.each([
    ["forbidden-word", FORBIDDEN],
    ["max-words", { kind: "max-words", limit: 8 } as AdherenceCheck],
    ["distinct-verbs", { kind: "distinct-verbs" } as AdherenceCheck],
  ])("FAILS %s on empty output rather than passing vacuously", (_label, check) => {
    // A model that returned nothing has not demonstrated compliance. Scoring
    // it as a pass would let the worst possible response inflate the adherence
    // rate — backwards for a criterion whose job is to detect being ignored.
    expect(scoreAdherence(check, [])).toBe(false);
  });
});

describe("describeCheck", () => {
  it("renders each kind for the committed report", () => {
    expect(describeCheck(FORBIDDEN)).toContain("spearheaded");
    expect(describeCheck({ kind: "max-words", limit: 15 })).toContain("15");
    expect(describeCheck({ kind: "distinct-verbs" })).toContain("different");
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";

import { checkNumbersPreserved } from "./preserve-numbers.ts";

describe("checkNumbersPreserved", () => {
  it("passes when every numeric token survives", () => {
    const input = [
      "Cut p99 latency 40% by sharding the write path.",
      "Drove $1.2M ARR across 3 enterprise rollouts.",
    ];
    const output = [
      "Reduced p99 latency by 40% via write-path sharding.",
      "Drove $1.2M ARR over 3 enterprise rollouts.",
    ];
    expect(checkNumbersPreserved(input, output)).toEqual({
      ok: true,
      dropped: [],
      added: [],
    });
  });

  it("flags a dropped percentage", () => {
    const input = ["Cut p99 latency 40% by sharding the write path."];
    const output = ["Reduced p99 latency by sharding the write path."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["40%"]);
    expect(result.added).toEqual([]);
  });

  it("flags an invented number", () => {
    const input = ["Improved availability."];
    const output = ["Improved availability by 99.9%."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual([]);
    expect(result.added).toEqual(["99.9%"]);
  });

  it("flags a substituted number — drops the original and adds the invented one", () => {
    const input = ["Saved the team $5K per quarter."];
    const output = ["Saved the team $10K per quarter."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["$5K"]);
    expect(result.added).toEqual(["$10K"]);
  });

  it("handles all the money/percent/magnitude/comma/decimal formats", () => {
    const input = [
      "Generated $1.2M in 2023 alone (up from $400K in 2022).",
      "Scaled to 1,200 RPS, with 99.95% uptime over a 6-month window.",
      "Compressed images by 10MB on average and trimmed bundle 3.4%.",
    ];
    expect(checkNumbersPreserved(input, input).ok).toBe(true);
  });

  it("treats date ranges as the pair of years and accepts a reworded range", () => {
    const input = ["Owned the platform from 2019-2021."];
    // Output reworks 2019-2021 as "between 2019 and 2021" — both years still
    // appear, so the check passes.
    const output = ["Owned the platform between 2019 and 2021."];
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("flags a dropped year from a date range", () => {
    const input = ["Owned the platform from 2019-2021."];
    const output = ["Owned the platform starting in 2019."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["2021"]);
  });

  it("treats bare-integer headcounts in people-management context as preservable", () => {
    const input = ["Led 5 engineers across two squads."];
    // Rewrite drops the headcount: the bare 5 is now missing.
    const output = ["Led engineers across two squads."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["5"]);
  });

  it("accepts a headcount reworded from 'led 5' to '5 engineers'", () => {
    const input = ["Led 5 engineers across two squads."];
    const output = ["Drove delivery with a team of 5 across two squads."];
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("accepts a headcount reworded from 'managed 8' to '8 reports'", () => {
    const input = ["Managed 8 across the data platform."];
    const output = ["Owned 8 reports across the data platform."];
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("counts numbers as a multiset — two distinct 5%s must both survive", () => {
    const input = ["Lifted CTR 5% in Q1 and another 5% in Q2."];
    // Rewrite collapses to one mention of 5%.
    const output = ["Lifted CTR 5% over Q1 and Q2."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["5%"]);
  });

  it("strips the headcount: / year: namespace for display tokens", () => {
    const dropped = checkNumbersPreserved(
      ["Led 5 engineers in 2021."],
      ["Drove delivery."],
    );
    expect(dropped.dropped).toEqual(expect.arrayContaining(["5", "2021"]));
    expect(dropped.dropped.every((t) => !t.includes(":"))).toBe(true);
  });

  it("is case-insensitive on magnitude suffixes", () => {
    const input = ["Drove $1.2M ARR."];
    const output = ["Drove $1.2m ARR."];
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("returns ok on empty input and empty output", () => {
    expect(checkNumbersPreserved([], [])).toEqual({
      ok: true,
      dropped: [],
      added: [],
    });
  });

  // ── Regressions from the reviewer pass ────────────────────────────────────

  it("flags a sign flip — `15%` rewritten as `-15%` inverts the meaning", () => {
    const input = ["Cut customer churn 15% YoY."];
    const output = ["Customer churn moved -15% YoY."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["15%"]);
    expect(result.added).toEqual(["-15%"]);
  });

  it("preserves an explicit negative metric round-trip", () => {
    const input = ["Reduced churn by -15% over Q3."];
    expect(checkNumbersPreserved(input, input).ok).toBe(true);
  });

  it("flags swapping `€500K` for `£500K` — non-$ currencies are tracked", () => {
    const input = ["Booked €500K in Q4."];
    const output = ["Booked £500K in Q4."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["€500K"]);
    expect(result.added).toEqual(["£500K"]);
  });

  it("accepts a yen round-trip — ¥1,200 stays ¥1,200", () => {
    const input = ["Signed a ¥1,200 retainer for the quarter."];
    expect(checkNumbersPreserved(input, input).ok).toBe(true);
  });

  it("preserves the original casing of magnitude suffixes in the display token", () => {
    const input = ["Saved $5K per quarter."];
    const output = ["Did the work."];
    const result = checkNumbersPreserved(input, output);
    expect(result.dropped).toEqual(["$5K"]);
  });

  it("does NOT over-trigger on bare `of` — `1 of 5 candidates` should not be tracked as headcount", () => {
    // `5 candidates` doesn't include a headcount noun ("candidates" isn't in
    // the noun list), so neither integer should produce a tracked token.
    const input = ["Reviewed 1 of 5 applicants for the lead role."];
    // Rewrite drops both bare integers — should NOT flag dropped tokens.
    const output = ["Reviewed lead-role applicants."];
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("does NOT over-trigger on `out of 10` — that's a fraction phrase, not a headcount", () => {
    const input = ["Won 7 out of 10 deals last quarter."];
    const output = ["Won most deals last quarter."];
    // Neither integer is in people-management context — both should be
    // ignored. (Bare integers without context aren't worth tracking.)
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("still catches headcount when the phrase is `team of 12`", () => {
    const input = ["Led a team of 12 across two squads."];
    const output = ["Led a team across two squads."];
    const result = checkNumbersPreserved(input, output);
    expect(result.ok).toBe(false);
    expect(result.dropped).toEqual(["12"]);
  });
});

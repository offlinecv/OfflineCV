// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

  it("counts numbers as a set — a repeated 5% survives as one mention", () => {
    // The deliberate trade recorded in the module docblock: collapsing two
    // separate 5% claims into one scores clean, because counting occurrences
    // instead would reject the licensed merge the test below pins.
    const input = ["Lifted CTR 5% in Q1 and another 5% in Q2."];
    const output = ["Lifted CTR 5% over Q1 and Q2."];
    expect(checkNumbersPreserved(input, output).ok).toBe(true);
  });

  it("strips the num: namespace for display tokens", () => {
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

  // ── #778: extraction gaps that let a real drop score clean ────────────────
  //
  // Every case below was INVISIBLE before #778: the token produced no atom at
  // all, so a rewrite could delete it and `ok` stayed true. Each one is
  // asserted twice — once that the token round-trips (no false reject) and
  // once that deleting it is caught (no false pass) — because a detector that
  // only does the first is indistinguishable from one that tracks nothing.

  describe("tilde-prefixed approximations (#778)", () => {
    it("catches a dropped `~50`", () => {
      const result = checkNumbersPreserved(
        ["Triaged ~50 support tickets a week."],
        ["Triaged support tickets each week."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["~50"]);
    });

    it("round-trips `~50` unchanged", () => {
      const input = ["Triaged ~50 support tickets a week."];
      expect(checkNumbersPreserved(input, input).ok).toBe(true);
    });

    it("treats `~50` and `50` as different claims, like `-15%` and `15%`", () => {
      const result = checkNumbersPreserved(
        ["Triaged ~50 tickets a week."],
        ["Triaged 50 tickets a week."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["~50"]);
    });

    it("keeps the approximation on a decorated token — `~$4.2M`", () => {
      const result = checkNumbersPreserved(
        ["Grew ARR to ~$4.2M."],
        ["Grew ARR."],
      );
      expect(result.dropped).toEqual(["~$4.2M"]);
    });

    it("accepts the ≈ and ∼ spellings a PDF extractor may emit", () => {
      const input = ["Lifted retention ≈30% and cut churn ∼12%."];
      expect(checkNumbersPreserved(input, input).ok).toBe(true);
      expect(
        checkNumbersPreserved(input, ["Lifted retention and cut churn."])
          .dropped,
      ).toEqual(["≈30%", "∼12%"]);
    });
  });

  describe("hyphenated ranges (#778)", () => {
    it("catches a range collapsed to one endpoint", () => {
      const result = checkNumbersPreserved(
        ["Handled 50-100 tickets per week."],
        ["Handled up to 100 tickets per week."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toContain("50");
    });

    it("catches a range dropped entirely", () => {
      const result = checkNumbersPreserved(
        ["Handled 50-100 tickets per week."],
        ["Handled inbound tickets each week."],
      );
      expect(result.dropped).toEqual(["50", "100"]);
    });

    it("round-trips a range unchanged", () => {
      const input = ["Handled 50-100 tickets per week."];
      expect(checkNumbersPreserved(input, input).ok).toBe(true);
    });

    it("matches across dash spellings — a hyphen range survives as an en dash", () => {
      // The dash is detection context, never part of the key, so re-spelling
      // it is not a drop. A PDF extractor picks the dash, not the author.
      expect(
        checkNumbersPreserved(
          ["Handled 50-100 tickets per week."],
          ["Handled 50–100 tickets per week."],
        ).ok,
      ).toBe(true);
    });

    it("tracks the bare endpoint of a mixed range — `10-15%`", () => {
      const result = checkNumbersPreserved(
        ["Lifted conversion 10-15% across the funnel."],
        ["Lifted conversion 15% across the funnel."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["10"]);
    });

    it("does NOT read `6-month` or `day-7` as a range — the dash is followed by a letter", () => {
      // Both bare integers stay untracked exactly as before #778, so dropping
      // them is not flagged. This is the false-reject guard for the change.
      const result = checkNumbersPreserved(
        ["Ran a 6-month pilot that lifted day-7 retention."],
        ["Ran a pilot that lifted retention."],
      );
      expect(result.ok).toBe(true);
    });

    it("still scores a date range as its pair of years, not as a range", () => {
      // Pinned because reading `2019-2021` as a range instead would make the
      // legitimate rewording below a drop.
      expect(
        checkNumbersPreserved(
          ["Owned the platform 2019-2021."],
          ["Owned the platform between 2019 and 2021."],
        ).ok,
      ).toBe(true);
    });
  });

  describe("multiplier and at-least suffixes (#778)", () => {
    it("catches a dropped `10x`", () => {
      const result = checkNumbersPreserved(
        ["Scaled ingestion throughput 10x in one quarter."],
        ["Scaled ingestion throughput substantially in one quarter."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["10x"]);
    });

    it("catches a dropped decimal multiplier `3.5x`", () => {
      // Before #778 the atom matched a stranded `3` here and classified it as
      // noise, so the whole figure was untracked.
      const result = checkNumbersPreserved(
        ["Grew revenue 3.5x year over year."],
        ["Grew revenue year over year."],
      );
      expect(result.dropped).toEqual(["3.5x"]);
    });

    it("is case-insensitive on the multiplier — `10X` matches `10x`", () => {
      expect(
        checkNumbersPreserved(["Scaled 10X."], ["Scaled 10x."]).ok,
      ).toBe(true);
    });

    it("catches a dropped `10+`", () => {
      const result = checkNumbersPreserved(
        ["Brings 10+ years of platform experience."],
        ["Brings years of platform experience."],
      );
      expect(result.dropped).toEqual(["10+"]);
    });

    it("treats `10+` and `10` as different claims", () => {
      const result = checkNumbersPreserved(
        ["Brings 10+ years of experience."],
        ["Brings 10 years of experience."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["10+"]);
    });

    it("does NOT match either side of a dimension pair — `1920x1080`, `2x2`", () => {
      // The `(?!\w)` boundary is what keeps these out; if it ever loosened,
      // dropping a resolution would start rejecting rewrites.
      const result = checkNumbersPreserved(
        ["Shipped 1920x1080 assets on a 2x2 grid."],
        ["Shipped assets on a grid."],
      );
      expect(result.ok).toBe(true);
    });
  });

  // ── Formatting must not decide whether a number is "present" ──────────────
  //
  // Whether a BARE integer is tracked depends on the prose around it, so the
  // same digits classify differently in `50 to 100` vs `50-100` and in
  // `12 people` vs `12-person team`. Comparing tracked-against-tracked made a
  // re-spelling look like a drop (or an invention) and reverted the section,
  // telling the user the model removed a number they typed themselves.

  describe("re-spelling a number is not a change (#778 review)", () => {
    it("accepts a spelled-out range tightened to a hyphen", () => {
      expect(
        checkNumbersPreserved(
          ["Handled 50 to 100 tickets."],
          ["Handled 50-100 tickets."],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("accepts a hyphenated range spelled out with `to`", () => {
      expect(
        checkNumbersPreserved(
          ["Handled 50-100 tickets."],
          ["Handled 50 to 100 tickets."],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("accepts a headcount re-attached as a hyphenated word suffix", () => {
      expect(
        checkNumbersPreserved(
          ["Managed 12 people."],
          ["Managed a 12-person team."],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("accepts the same move in reverse — `12-person team` back to `12 people`", () => {
      expect(
        checkNumbersPreserved(
          ["Managed a 12-person team."],
          ["Managed 12 people."],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("still catches a real drop from a re-spelled range", () => {
      // The fix must not blunt detection: `50` is gone from the output
      // entirely, in any formatting, so it is still a drop.
      const result = checkNumbersPreserved(
        ["Handled 50-100 tickets."],
        ["Handled up to 100 tickets."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["50"]);
    });

    it("still catches a real drop of a re-spelled headcount", () => {
      const result = checkNumbersPreserved(
        ["Managed 12 people."],
        ["Managed a small team."],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["12"]);
    });

    it("still catches an invented headcount that appears in no formatting before", () => {
      const result = checkNumbersPreserved(
        ["Managed the platform team."],
        ["Managed 12 engineers on the platform team."],
      );
      expect(result.ok).toBe(false);
      expect(result.added).toEqual(["12"]);
    });
  });

  describe("grouping commas are formatting, not value (#778 review)", () => {
    // Same digits, same claim, different spelling. Keying on the literal form
    // made `1,200` and `1200` two different numbers, so a rewrite that only
    // regrouped the figure was reported as dropping (or inventing) it and the
    // whole section reverted — the same false-revert class as `50 to 100` vs
    // `50-100`, on the formatting axis instead of the prose one.

    it("accepts a grouped integer written without its commas", () => {
      expect(
        checkNumbersPreserved(
          ["Processed 1,200 orders"],
          ["Processed 1200 orders"],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("accepts the same move in reverse — `1200` regrouped as `1,200`", () => {
      expect(
        checkNumbersPreserved(
          ["Processed 1200 orders"],
          ["Processed 1,200 orders"],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("accepts a six-figure count losing its commas", () => {
      expect(
        checkNumbersPreserved(
          ["Served 100,000 users"],
          ["Served 100000 users"],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("accepts a regrouped headcount — the people context still matches", () => {
      // Crosses both axes at once: the input figure is claimed by its grouping,
      // the output figure by the verb in front of it.
      expect(
        checkNumbersPreserved(
          ["Managed 1,200 employees"],
          ["Managed 1200 employees"],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("normalises grouping inside a decorated token too — `$1,200` ≡ `$1200`", () => {
      expect(
        checkNumbersPreserved(["Saved $1,200 a month"], ["Saved $1200 a month"])
          .ok,
      ).toBe(true);
    });

    it("still catches a grouped figure that disappears entirely", () => {
      const result = checkNumbersPreserved(
        ["Processed 1,200 orders"],
        ["Processed the order backlog"],
      );
      expect(result.ok).toBe(false);
      // Quoted back in the spelling the user wrote, commas included.
      expect(result.dropped).toEqual(["1,200"]);
    });

    it("still catches a grouped figure swapped for a different value", () => {
      const result = checkNumbersPreserved(
        ["Processed 1,200 orders"],
        ["Processed 2,400 orders"],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["1,200"]);
      expect(result.added).toEqual(["2,400"]);
    });
  });

  describe("an invented headcount is not excused by an unrelated digit (#778 review)", () => {
    // The add direction cannot use the drop direction's lenient lookup: that a
    // digit appears SOMEWHERE in the input says nothing about whether the claim
    // the output makes with it was ever made. Merging every bare integer into
    // one `num:` namespace (the fix for the drop-side false positives) is what
    // opened this — before it, a headcount lived in its own namespace and the
    // invention below was caught.

    it("flags `phase 5` rewritten as `5 engineers`", () => {
      const result = checkNumbersPreserved(
        ["Completed phase 5 of the migration"],
        ["Managed 5 engineers through the migration"],
      );
      expect(result.ok).toBe(false);
      expect(result.added).toEqual(["5"]);
      expect(result.dropped).toEqual([]);
    });

    it("flags a headcount minted from a section number", () => {
      const result = checkNumbersPreserved(
        ["Wrote section 8 of the runbook"],
        ["Led 8 developers on the runbook"],
      );
      expect(result.ok).toBe(false);
      expect(result.added).toEqual(["8"]);
    });

    it("does NOT flag a headcount the input already asserted, re-spelled", () => {
      // The false-positive guard for the rule above, both directions: `12` is a
      // people claim on both sides, so the hyphenated attachment is a rewording
      // and not a new assertion.
      expect(
        checkNumbersPreserved(
          ["Managed a 12-person team."],
          ["Managed 12 people."],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
      expect(
        checkNumbersPreserved(
          ["Managed 12 people."],
          ["Managed a 12-person team."],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("does NOT flag a range endpoint that only gained its dash", () => {
      // Range and grouping stay on the lenient lookup: an untracked→tracked
      // move there is the re-spelling rule 1 protects, not a new claim.
      expect(
        checkNumbersPreserved(
          ["Handled 50 to 100 tickets."],
          ["Handled 50-100 tickets."],
        ).added,
      ).toEqual([]);
      expect(
        checkNumbersPreserved(
          ["Processed 1200 orders"],
          ["Processed 1,200 orders"],
        ).added,
      ).toEqual([]);
    });

    it("keeps the drop direction lenient — a headcount demoted to a plain digit is not a drop", () => {
      // The asymmetry, pinned from the other side. Rule 1 asks only whether the
      // VALUE survived, because the prose that decides tracking is exactly what
      // a rewrite is licensed to move; tightening this direction is what made
      // the gate fire on numbers the user typed themselves.
      expect(
        checkNumbersPreserved(
          ["Managed 5 engineers on the migration"],
          ["Completed phase 5 of the migration"],
        ).dropped,
      ).toEqual([]);
    });
  });

  describe("set semantics for a licensed merge (#778 review)", () => {
    it("accepts a merge that de-duplicates a repeated metric", () => {
      // MERGE_AND_PRUNE_RULE licenses this. Under multiset semantics the
      // output's single `5%` looked like one of the two inputs being dropped,
      // and the gate discarded the whole section's rewrite over it.
      expect(
        checkNumbersPreserved(
          ["Cut 5% cost", "Cut 5% churn"],
          ["Cut 5% cost and churn"],
        ),
      ).toEqual({ ok: true, dropped: [], added: [] });
    });

    it("still accepts the merge that moves two distinct metrics into one bullet", () => {
      expect(
        checkNumbersPreserved(
          ["Cut latency 40%", "Saved $4.2M"],
          ["Cut latency 40% and saved $4.2M"],
        ).ok,
      ).toBe(true);
    });

    it("still catches a genuine drop when the only instance disappears", () => {
      const result = checkNumbersPreserved(
        ["Cut 5% cost", "Cut 12% churn"],
        ["Cut 5% cost and churn"],
      );
      expect(result.ok).toBe(false);
      expect(result.dropped).toEqual(["12%"]);
    });

    it("reports a repeated dropped token once, not once per occurrence", () => {
      const result = checkNumbersPreserved(
        ["Cut 5% cost", "Cut 5% churn"],
        ["Cut cost and churn"],
      );
      expect(result.dropped).toEqual(["5%"]);
    });
  });
});

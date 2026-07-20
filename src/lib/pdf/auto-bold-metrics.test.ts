// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for `autoBoldMetrics` (#425) — the pure helper that wraps
 * quantifiable bullet metrics in sentinel emphasis markers for the PDF
 * renderer. Covers every metric shape the issue calls out, idempotency, that
 * non-metric prose is left untouched, and — critically (#284) — that literal
 * `**` already present in the source text is INERT (never mistaken for a
 * generated marker and stripped). The `score/auto-bold.ts` cases folded in at
 * the bottom document the module consolidation: this is now the ONE metric
 * auto-bolder.
 */

import { describe, it, expect } from "vitest";
import {
  autoBoldMetrics,
  EMPHASIS_OPEN,
  EMPHASIS_CLOSE,
} from "./auto-bold-metrics.ts";

/** Wrap `s` in the sentinel emphasis delimiters — mirrors what the helper emits. */
const b = (s: string) => `${EMPHASIS_OPEN}${s}${EMPHASIS_CLOSE}`;

describe("autoBoldMetrics", () => {
  it("bolds a plain percentage", () => {
    expect(autoBoldMetrics("Grew revenue 40% year over year")).toBe(
      `Grew revenue ${b("40%")} year over year`,
    );
  });

  it("bolds approximate and decimal percentages", () => {
    expect(autoBoldMetrics("Reduced latency ~10% and errors 12.5%")).toBe(
      `Reduced latency ${b("~10%")} and errors ${b("12.5%")}`,
    );
  });

  it("bolds a trailing-'+' percentage and a decimal multiplier", () => {
    expect(autoBoldMetrics("Cut costs by 30%+ and grew 1.5x")).toBe(
      `Cut costs by ${b("30%+")} and grew ${b("1.5x")}`,
    );
  });

  it("bolds a dollar amount with a magnitude suffix", () => {
    expect(autoBoldMetrics("Closed $2M in new ARR")).toBe(
      `Closed ${b("$2M")} in new ARR`,
    );
  });

  it("bolds a dollar amount that carries an ARR suffix", () => {
    expect(autoBoldMetrics("Hit $500K ARR in six months")).toBe(
      `Hit ${b("$500K ARR")} in six months`,
    );
  });

  it("bolds a comma-grouped dollar amount", () => {
    expect(autoBoldMetrics("Raised $3,000 from angels")).toBe(
      `Raised ${b("$3,000 ")}from angels`,
    );
  });

  it("bolds an integer multiplier", () => {
    expect(autoBoldMetrics("Improved throughput 2x over baseline")).toBe(
      `Improved throughput ${b("2x")} over baseline`,
    );
  });

  it("bolds a magnitude-suffixed scale metric with a unit", () => {
    expect(autoBoldMetrics("Onboarded 50K users in Q1")).toBe(
      `Onboarded ${b("50K users")} in Q1`,
    );
  });

  it("bolds a headcount metric", () => {
    expect(autoBoldMetrics("Managed 18 engineers across two pods")).toBe(
      `Managed ${b("18 engineers")} across two pods`,
    );
  });

  it("bolds a hyphenated headcount with a 'team' suffix", () => {
    expect(autoBoldMetrics("Built a 200-person team from scratch")).toBe(
      `Built a ${b("200-person team")} from scratch`,
    );
  });

  it("bolds a '+'-suffixed count with a unit", () => {
    expect(autoBoldMetrics("Served 65+ features")).toBe(
      `Served ${b("65+ features")}`,
    );
  });

  it("bolds a duration metric", () => {
    expect(autoBoldMetrics("Shipped in 6 weeks")).toBe(
      `Shipped in ${b("6 weeks")}`,
    );
  });

  it("leaves non-metric prose untouched", () => {
    const text = "Led a team to build great software for our customers";
    expect(autoBoldMetrics(text)).toBe(text);
  });

  it("leaves a bare number with no recognized unit un-emphasized", () => {
    const text = "Owned roadmap for 3 quarters of planning and 4 launches";
    // "3 quarters" IS a duration unit → bolded; "4 launches" has no unit → not.
    expect(autoBoldMetrics(text)).toBe(
      `Owned roadmap for ${b("3 quarters")} of planning and 4 launches`,
    );
  });

  it("is idempotent — an already-marked metric is not re-wrapped", () => {
    const once = autoBoldMetrics("Grew revenue 40% and cut latency 10%");
    expect(autoBoldMetrics(once)).toBe(once);
  });

  it("returns falsy input unchanged", () => {
    expect(autoBoldMetrics("")).toBe("");
  });

  // ── Literal `**` inertness (#284 round-trip corruption fix) ───────────────
  // The delimiter is a Private-Use-Area sentinel, NOT `**`, so any literal
  // asterisks a user typed pass through verbatim — never consumed as a marker.

  it("leaves a literal balanced `**important**` untouched (no metric)", () => {
    const text = "Wrote **important** design docs for the team";
    expect(autoBoldMetrics(text)).toBe(text);
  });

  it("preserves literal `**` while still bolding a real metric", () => {
    expect(autoBoldMetrics("Wrote **important** docs, grew 40%")).toBe(
      `Wrote **important** docs, grew ${b("40%")}`,
    );
  });

  it("leaves an unbalanced/adjacent literal `**` untouched", () => {
    const text = "Rated it 5** and shipped **fast** with ** stray marks";
    expect(autoBoldMetrics(text)).toBe(text);
  });

  // ── Folded from the retired score/auto-bold.ts test (#425 consolidation) ──

  it("(folded) bolds a percentage mid-sentence", () => {
    expect(autoBoldMetrics("Increased revenue by 40%")).toBe(
      `Increased revenue by ${b("40%")}`,
    );
  });

  it("(folded) bolds a dollar amount", () => {
    expect(autoBoldMetrics("Saved $2M in costs")).toContain(b("$2M"));
  });

  it("(folded) bolds a multiplier", () => {
    expect(autoBoldMetrics("Achieved 10x improvement")).toContain(b("10x"));
  });

  it("(folded) bolds a headcount", () => {
    expect(autoBoldMetrics("Managed 12 engineers")).toContain(
      b("12 engineers"),
    );
  });

  it("(folded) bolds a duration", () => {
    expect(autoBoldMetrics("Completed in 6 weeks")).toContain(b("6 weeks"));
  });

  it("(folded) leaves a bare count without a unit untouched", () => {
    expect(autoBoldMetrics("We had 5 of them")).toBe("We had 5 of them");
  });
});

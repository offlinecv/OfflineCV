// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ScoreDimensionRow + `formatCompletenessHint` + `scoreBandParts` (#953).
 *
 * `formatCompletenessHint` is the only branching prose in the score widget and
 * it shipped with no direct cover. The `redactedDates` branch matters most: it
 * fires on a résumé whose dates the parser could not read, which is exactly
 * when the user needs the advice, and it composes onto BOTH the present and
 * missing shapes.
 *
 * The rendering assertion is a guard, not a snapshot: this row must not carry
 * a `title` attribute. Hover-only text is unreachable by keyboard and dead on
 * touch — the defect this PR removed from `VerdictHeader` and then briefly
 * reintroduced here.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ScoreDimensionRow,
  formatCompletenessHint,
} from "./ScoreDimensionRow.tsx";
import { scoreBandParts } from "./scoreBand.ts";

describe("formatCompletenessHint", () => {
  it("names the missing fields", () => {
    expect(formatCompletenessHint({ missing: ["phone", "email"] })).toBe(
      "Missing: phone, email",
    );
  });

  it("reports an all-present contact block", () => {
    expect(formatCompletenessHint({ missing: [] })).toBe(
      "All expected fields present",
    );
  });

  it("appends the redacted-dates advice onto the missing shape", () => {
    const hint = formatCompletenessHint({
      missing: ["phone"],
      redactedDates: true,
    });
    expect(hint).toContain("Missing: phone");
    expect(hint).toContain("4-digit years");
  });

  it("appends the redacted-dates advice onto the all-present shape", () => {
    const hint = formatCompletenessHint({ missing: [], redactedDates: true });
    expect(hint).toContain("All expected fields present");
    expect(hint).toContain("4-digit years");
  });

  it("omits the advice when redactedDates is explicitly false", () => {
    expect(
      formatCompletenessHint({ missing: [], redactedDates: false }),
    ).not.toContain("4-digit years");
  });
});

describe("scoreBandParts", () => {
  it("rounds the percent off the value/max pair", () => {
    expect(scoreBandParts(30, 40).pct).toBe(75);
  });

  it("returns 0 rather than NaN for an ungradable zero max", () => {
    // A NaN width silently drops the bar instead of rendering an empty one.
    const { pct } = scoreBandParts(0, 0);
    expect(pct).toBe(0);
    expect(Number.isNaN(pct)).toBe(false);
  });

  it("gives a high score a different band than a low one", () => {
    expect(scoreBandParts(39, 40).barCls).not.toBe(scoreBandParts(4, 40).barCls);
  });
});

describe("ScoreDimensionRow", () => {
  const base = {
    label: "Structure",
    value: 24,
    max: 30,
    gradable: true,
    hint: "verb-led 8/10 · length 8/10",
    anchor: "#reconstructed-resume" as const,
  };

  it("renders the hint as visible text, never as a title attribute", () => {
    const html = renderToStaticMarkup(<ScoreDimensionRow {...base} />);
    expect(html).toContain("verb-led 8/10");
    expect(html).not.toContain("title=");
  });

  it("stays an anchor to its section", () => {
    const html = renderToStaticMarkup(<ScoreDimensionRow {...base} />);
    expect(html).toContain('href="#reconstructed-resume"');
  });

  it("renders a dash and no fraction when the dimension is ungradable", () => {
    const html = renderToStaticMarkup(
      <ScoreDimensionRow {...base} gradable={false} max={0} value={0} />,
    );
    expect(html).toContain("—");
    expect(html).not.toContain("0/0");
  });
});

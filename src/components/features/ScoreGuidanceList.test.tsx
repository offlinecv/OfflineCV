// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * ScoreGuidanceList — the located "what to change" rows (#810).
 *
 * Display-only, so this renders to static markup in the shape
 * `ScoreDimensionRow.test.tsx` uses rather than driving a root.
 *
 * Three properties are worth pinning, and each is one the component could lose
 * without looking broken:
 *
 * 1. Empty renders NOTHING. The acceptance criterion is "a résumé scoring well
 *    renders no guidance chrome, not an empty container" — a heading over an
 *    empty list still reads as a surface that failed to load, and it is the
 *    easy regression if someone later hoists the `<h3>` above the guard.
 * 2. The location is TEXT, never a `title=`. `ScoreDimensionRow`'s docblock
 *    records this trap: hover-only prose is unreachable by keyboard and dead
 *    on touch, and it has already been reintroduced once on this surface after
 *    being removed from `VerdictHeader`. This row carries the most actionable
 *    text on the page, so it is the worst possible place to lose it.
 * 3. The dimension badge is the `info` tone, not `warning` — a dimension name
 *    is a category, not a verdict on the line beside it (see the component
 *    docblock, and `StatusBadge`'s own note on why #204 added `neutral`).
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreGuidanceList } from "./ScoreGuidanceList.tsx";
import type { ScoreGuidanceItem } from "../../lib/score/guidance.ts";

function item(overrides: Partial<ScoreGuidanceItem> = {}): ScoreGuidanceItem {
  return {
    dimension: "specificity",
    where: "Experience → Staff Engineer — Acme → bullet 3",
    action: "add a number — an amount, a percentage, or a count",
    ...overrides,
  };
}

function render(items: readonly ScoreGuidanceItem[]): string {
  return renderToStaticMarkup(<ScoreGuidanceList items={items} />);
}

describe("ScoreGuidanceList — the no-chrome contract (#810)", () => {
  it("renders nothing at all for an empty list", () => {
    expect(render([])).toBe("");
  });

  it("renders no heading either — not an empty container", () => {
    expect(render([]).toLowerCase()).not.toContain("what to change");
  });
});

describe("ScoreGuidanceList — rows", () => {
  it("renders one row per item", () => {
    const html = render([
      item(),
      item({ dimension: "structure", where: "Experience → A → bullet 1" }),
    ]);
    expect(html.match(/<li/g) ?? []).toHaveLength(2);
  });

  it("names the place and the action as visible text", () => {
    const html = render([item()]);
    expect(html).toContain("Experience → Staff Engineer — Acme → bullet 3");
    expect(html).toContain("add a number");
  });

  it("labels each row with its dimension", () => {
    const html = render([
      item({ dimension: "specificity" }),
      item({ dimension: "structure" }),
      item({ dimension: "completeness" }),
    ]);
    expect(html).toContain("Specificity");
    expect(html).toContain("Structure");
    expect(html).toContain("Completeness");
  });

  it("puts the location in the document, never in a title attribute", () => {
    const html = render([item()]);
    expect(html).not.toContain("title=");
  });

  it("tones the dimension badge as a category, not a fault", () => {
    const html = render([item()]);
    // `info` tokens, not `warning` — see the component docblock.
    expect(html).toContain("feedback-info");
    expect(html).not.toContain("feedback-warning");
  });

  it("renders the rows as a real list, so the count is exposed to a reader", () => {
    const html = render([item(), item()]);
    expect(html).toContain("<ul");
  });
});

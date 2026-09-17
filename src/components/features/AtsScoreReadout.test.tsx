// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Anchor-resolution regression test for the score tiles (#153).
 *
 * The three dimension tiles (Specificity / Structure / Completeness) each link
 * to a section id via `<a href="#…">`. Two of them used to point at
 * `#per-bullet-feedback`, an id no element renders — so clicking them was a
 * silent no-op (only Completeness, on `#contact`, scrolled).
 *
 * This renders `<AtsScoreReadout>`, collects every tile anchor from the DOM, and
 * asserts each resolves to a known scroll target in the typed `SECTION_IDS`
 * contract. The target components (`ContactCard`, `ReconstructedResume`) render
 * their `id` from that same constant, so contract membership guarantees a live
 * target — a dead link like `#per-bullet-feedback` fails here immediately.
 *
 * Runs in jsdom with raw `createRoot`, matching `ContactCard.test.tsx`.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { AtsScoreReadout } from "./AtsScoreReadout.tsx";
import { ContactCard } from "./ContactCard.tsx";
import { SECTION_IDS } from "../../lib/anchors.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";

function makeScore(): AnonymousAtsScore {
  return {
    overall: 72,
    preLayoutOverall: 72,
    specificity: {
      score: 30,
      max: 40,
      gradable: true,
      metricBullets: 6,
      totalBullets: 10,
    },
    structure: {
      score: 24,
      max: 30,
      gradable: true,
      goodBullets: 8,
      verbLedBullets: 8,
      inWindowBullets: 8,
      totalBullets: 10,
    },
    completeness: {
      score: 18,
      max: 30,
      gradable: true,
      missing: ["phone"],
    },
    layout: { triggers: [], multiplier: 1, scanned: false },
    algoVersion: "test",
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(
  score: AnonymousAtsScore,
  defaultCollapsed?: boolean,
): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(AtsScoreReadout, { score, defaultCollapsed }));
  });
  return container;
}

/** Minimal CascadeResult so ContactCard renders its `id={SECTION_IDS.contact}`. */
function renderContactCard(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const result = {
    canonical: {
      fields: { skills: [], experience: [], education: [] },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
  } as unknown as CascadeResult;
  act(() => {
    root!.render(createElement(ContactCard, { result }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

/** Every hash href the rendered tiles link to. */
function tileAnchors(el: HTMLDivElement): string[] {
  return Array.from(el.querySelectorAll("a[href^='#']")).map(
    (a) => a.getAttribute("href") ?? "",
  );
}

describe("AtsScoreReadout tile anchors", () => {
  it("points every dimension tile at a known scroll target", () => {
    const anchors = tileAnchors(render(makeScore()));

    // All three tiles render as anchors.
    expect(anchors).toHaveLength(3);

    const validTargets = new Set<string>(
      Object.values(SECTION_IDS).map((id) => `#${id}`),
    );
    for (const href of anchors) {
      expect(validTargets.has(href)).toBe(true);
    }
  });

  it("does not resurrect the dead #per-bullet-feedback anchor", () => {
    expect(tileAnchors(render(makeScore()))).not.toContain(
      "#per-bullet-feedback",
    );
  });
});

describe("Structure hint — two direct counts, not the fused sum (issue 624)", () => {
  // The mislabel this guards: the Structure tile used to print the half-credit
  // `goodBullets` sum under a "verb-led" label, so a résumé whose bullets were
  // all in-window and none verb-led read as partially verb-led. `score.test.ts`
  // pins the two new fields on the score object; this pins what the tile RENDERS
  // from them — the layer the bug actually lived at.
  it("renders 'verb-led 0/23 · length 23/23' for an all-in-window, none-verb-led résumé", () => {
    const score = makeScore();
    score.structure = {
      ...score.structure,
      verbLedBullets: 0,
      inWindowBullets: 23,
      totalBullets: 23,
    };
    expect(render(score).textContent).toContain(
      "verb-led 0/23 · length 23/23",
    );
  });
});

describe("compacted hero (#953) — explainer moved into a Popover, no <details>", () => {
  it("does not render the old subtitle/details explainer prose at rest", () => {
    const el = render(makeScore());
    const text = el.textContent ?? "";
    // The old always-visible subtitle sentence and the collapsed <details>
    // explainer both moved into the Popover panel, which is closed by
    // default — so neither the sentence nor the "How is this scored?"
    // accessible name (an aria-label, not text content) should appear.
    expect(text).not.toContain("Scored from what a generic text extractor");
    expect(text).not.toContain("How is this scored?");
  });

  it("renders no <details> element in the section", () => {
    const el = render(makeScore());
    expect(el.querySelector("details")).toBeNull();
  });

  it("applies the responsive single-row layout class", () => {
    const el = render(makeScore());
    expect(el.innerHTML).toContain("md:flex-row");
  });

  it("still renders exactly 3 dimension anchors after the row layout change", () => {
    expect(tileAnchors(render(makeScore()))).toHaveLength(3);
  });
});

describe("scroll-target render (end-to-end wiring)", () => {
  // Membership in SECTION_IDS proves the anchor *side*. This proves a target
  // *side* actually paints its id — a light-target end-to-end guard that would
  // catch a hardcoded/mismatched id the type system can't (a raw `id="contactx"`
  // instead of `id={SECTION_IDS.contact}`). ReconstructedResume is too heavy to
  // stub here, so ContactCard stands in for the target side.
  it("ContactCard renders a live #contact scroll target", () => {
    const el = renderContactCard();
    expect(el.querySelector(`#${SECTION_IDS.contact}`)).not.toBeNull();
  });
});

describe("collapsible score widget (#953)", () => {
  it("renders in collapsed mode when defaultCollapsed is true", () => {
    const el = render(makeScore(), true);
    expect(el.textContent).toContain("Score details ▾");
    // The collapsed bar still MOUNTS all 3 dimension anchors. Note what this
    // does and does not prove: their container is `hidden sm:flex`, and jsdom
    // applies no CSS, so this asserts the anchor contract survives the
    // collapse — not that a phone-width user can see them. Below `sm` the
    // dimensions are reached through the expand control instead.
    expect(tileAnchors(el)).toHaveLength(3);
  });

  it("expands when 'Score details ▾' is clicked and collapses when 'Collapse ▴' is clicked", () => {
    const el = render(makeScore(), true);
    expect(el.textContent).toContain("Score details ▾");

    // Click Score details ▾ to expand
    const expandBtn = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Score details ▾"),
    );
    expect(expandBtn).toBeDefined();
    act(() => expandBtn!.click());

    // Now in expanded state
    expect(el.textContent).toContain("Collapse ▴");
    expect(el.innerHTML).toContain("md:flex-row");

    // Click Collapse ▴ to collapse back
    const collapseBtn = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Collapse ▴"),
    );
    expect(collapseBtn).toBeDefined();
    act(() => collapseBtn!.click());

    // Back to collapsed state
    expect(el.textContent).toContain("Score details ▾");
  });

  it("auto-collapses after timer expires", () => {
    vi.useFakeTimers();
    try {
      const el = render(makeScore(), false);
      expect(el.textContent).toContain("Collapse ▴");

      act(() => {
        vi.advanceTimersByTime(4600);
      });

      expect(el.textContent).toContain("Score details ▾");
    } finally {
      vi.useRealTimers();
    }
  });
});


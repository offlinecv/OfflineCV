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

import { describe, expect, it, afterEach } from "vitest";
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

function render(score: AnonymousAtsScore): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(AtsScoreReadout, { score }));
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

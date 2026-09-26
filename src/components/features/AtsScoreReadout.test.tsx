// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Anchor-resolution regression test for the score tiles (#153), plus the
 * two-state score widget's own render contract.
 *
 * Mounted through `ScoreDetails`, not `AtsScoreReadout` directly. #955 made
 * the readout CONTROLLED — the countdown, the scroll, the hold and the user
 * lock all moved up into `ScoreDetails`, because the guarded element now has
 * to contain the score details beside the ring. Rendering the readout alone
 * here would still exercise its markup, but the collapse tests below (timer,
 * click-to-toggle) would have nothing to drive, so the host is the wrapper and
 * the assertions are unchanged. `ScoreDetails` is given no children, so
 * everything in these DOMs comes from the readout.
 *
 * The three dimension tiles (Specificity / Structure / Completeness) each link
 * to a section id via `<a href="#…">`. Two of them used to point at
 * `#per-bullet-feedback`, an id no element renders — so clicking them was a
 * silent no-op (only Completeness, on `#contact`, scrolled).
 *
 * This renders `<AtsScoreReadout>`, collects every tile anchor from the DOM, and
 * asserts each resolves to a known scroll target in the typed
 * `SCORE_TILE_SECTION_IDS` contract (#973). The target components (`ContactCard`,
 * `ReconstructedResume`) render their `id` from that same constant, so contract
 * membership guarantees a live target — a dead link like `#per-bullet-feedback`
 * fails here immediately.
 *
 * Runs in jsdom with raw `createRoot`, matching `ContactCard.test.tsx`.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ScoreDetails } from "./ScoreDetails.tsx";
import { ContactCard } from "./ContactCard.tsx";
import { SECTION_IDS, SCORE_TILE_SECTION_IDS } from "../../lib/anchors.ts";
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
  guidanceCount?: number,
  onEnterFixIt?: () => void,
): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(ScoreDetails, {
        score,
        defaultCollapsed,
        guidanceCount,
        onEnterFixIt,
      }),
    );
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
  it("points every dimension tile at a known score-tile scroll target (#973)", () => {
    const anchors = tileAnchors(render(makeScore()));

    // All three tiles render as anchors.
    expect(anchors).toHaveLength(3);

    const validTargets = new Set<string>(
      Object.values(SCORE_TILE_SECTION_IDS).map((id) => `#${id}`),
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

  it("does not point dimension tiles at documentBody (#973)", () => {
    expect(tileAnchors(render(makeScore()))).not.toContain(
      `#${SECTION_IDS.documentBody}`,
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
    // does and does not prove: their container is `hidden lg:flex`, and jsdom
    // applies no CSS, so this asserts the anchor contract survives the
    // collapse — not that a sub-`lg` user can see them. Below `lg` the
    // dimensions are reached through the expand control instead.
    expect(tileAnchors(el)).toHaveLength(3);
    const validTargets = new Set<string>(
      Object.values(SCORE_TILE_SECTION_IDS).map((id) => `#${id}`),
    );
    for (const href of tileAnchors(el)) {
      expect(validTargets.has(href)).toBe(true);
    }
    expect(tileAnchors(el)).not.toContain(`#${SECTION_IDS.documentBody}`);
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

// Shared by the two band-loop tests below: renders each of the three verdict
// bands, hands the caller's assertion the rendered root + word, and checks
// that whatever width class it returns is the SAME across all three bands —
// the actual fix for the #960/#988 wrap, since it makes the slot's width
// independent of which band rendered rather than of whether the word renders
// at all. The per-test assertions differ (pill-scoped vs strip-wide lookup,
// `sm:w-` vs bare `w-`, the `hidden` check), so only this loop is shared.
const VERDICT_BANDS = [
  [92, "Strong"],
  [72, "Getting There"],
  [40, "Needs Work"],
] as const;

function expectSharedWidthClassAcrossBands(
  widthClassFor: (el: HTMLElement, word: string) => string | undefined,
): void {
  const widthClasses = new Set<string>();
  for (const [overall, word] of VERDICT_BANDS) {
    const score = { ...makeScore(), overall };
    const el = render(score, true);
    const widthClass = widthClassFor(el, word);
    expect(widthClass, `${word} slot width class`).toBeDefined();
    widthClasses.add(widthClass!);
  }
  expect(widthClasses.size).toBe(1);
}

describe("docked strip is structurally one line, not text-metric luck (#960)", () => {
  // jsdom has no layout engine and can never see a wrap — that regression
  // proof lives in `e2e/viewport.spec.ts` / `e2e/mobile/*.spec.ts`. What jsdom
  // CAN see is the class contract the fix depends on: the verdict word is
  // still visible text (color is never the sole carrier of the band — an
  // earlier version of this fix dropped it to color-only and that was a
  // WCAG 1.4.1 regression, caught in review), but it now sits in a
  // FIXED-width slot rather than at its own intrinsic width, so the pill's
  // width no longer depends on which band rendered. The optional layout
  // penalty span still renders nowhere in the docked pill.
  it("renders the verdict word for every band, inside the SAME fixed-width slot", () => {
    expectSharedWidthClassAcrossBands((el, word) => {
      const pill = [...el.querySelectorAll("button")].find((b) =>
        b.getAttribute("aria-label")?.startsWith("Resume score"),
      );
      expect(pill?.getAttribute("aria-label")).toContain(word);
      expect(pill?.textContent).toContain(word);

      // The element carrying the visible word text must be the one with the
      // fixed-width slot class — otherwise a differently-sized ancestor
      // could still make the PILL's rendered width band-dependent even
      // though the word itself is present.
      const wordEl = [...(pill?.querySelectorAll("span") ?? [])].find(
        (s) => s.textContent === word,
      );
      return [...(wordEl?.classList ?? [])].find((c) => c.startsWith("sm:w-"));
    });
  });

  it("renders the verdict word below `sm` too, in its own narrower fixed-width slot (#988)", () => {
    // #965/#960 shipped this word `hidden` below `sm`, leaving the coloured
    // dot as the only visible band signal on a phone screen — a WCAG 1.4.1
    // regression, since the docked strip is where the widget spends most of
    // its life. #988 restores the word there too, in a narrower slot
    // (`w-5`) than the `sm:w-28` one used at `sm`+ — jsdom applies no CSS
    // so it cannot prove either slot actually fits the row (that's
    // `e2e/mobile/score-strip.spec.ts`), but it CAN prove the class contract:
    // no `hidden` class gating the word away below `sm`, and one shared
    // width class across all three bands so the slot's width still does not
    // depend on which band rendered.
    expectSharedWidthClassAcrossBands((el, word) => {
      const wordEl = [...el.querySelectorAll("span")].find(
        (s) => s.textContent === word,
      );
      expect(wordEl, `${word} slot`).toBeDefined();
      expect(
        [...(wordEl?.classList ?? [])],
        `${word} slot must not be hidden below sm`,
      ).not.toContain("hidden");
      return [...(wordEl?.classList ?? [])].find(
        (c) => c.startsWith("w-") && !c.startsWith("sm:"),
      );
    });
  });

  it("keeps the verdict word unwrappable inside its fixed-width slot", () => {
    // The fixed-width slot is only a fix while its contents stay on one line.
    // Two of the three labels are two words, so without `truncate`
    // (`white-space: nowrap` + `overflow: hidden` + ellipsis) the span breaks
    // at its space the moment the text needs more than the slot's 112px and
    // re-inflates the pill — measured 26px -> 47.3px docked with the verdict
    // word alone at 14px, which Chrome's minimum-font-size setting reaches
    // without any code change. jsdom cannot see the wrap; `e2e/viewport.spec.ts`
    // forces the font-size up and asserts the row holds. This pins the class
    // that makes that possible.
    for (const [overall, word] of VERDICT_BANDS) {
      const el = render({ ...makeScore(), overall }, true);
      const wordEl = [...el.querySelectorAll("span")].find(
        (s) => s.textContent === word,
      );
      expect(wordEl, `${word} slot`).toBeDefined();
      expect([...wordEl!.classList], `${word} slot`).toContain("truncate");
    }
  });

  it("does not render the inline layout-penalty span when docked, even when the multiplier is < 1", () => {
    const score = makeScore();
    score.layout = { triggers: ["two-column"], multiplier: 0.85, scanned: false };
    const el = render(score, true);
    expect(el.textContent).not.toContain("layout penalty");
  });

  it("reveals the dimension track group at lg, never at md or sm", () => {
    // `lg`, not the `md` #960 first shipped: at 768px the row's leftover
    // width fits no whole set of tiles, and #960's `overflow-hidden` turned
    // that shortfall into a tile sliced through its own text instead of an
    // absent one. Below `lg` the group must be `display:none` — absent from
    // the tab order too, not merely invisible.
    const el = render(makeScore(), true);
    expect(el.innerHTML).toContain("hidden min-w-0");
    expect(el.innerHTML).toContain("lg:flex");
    expect(el.innerHTML).not.toContain("md:flex");
    expect(el.innerHTML).not.toContain("sm:flex");
  });

  it("applies flex-nowrap (never flex-wrap) to the docked strip root", () => {
    const el = render(makeScore(), true);
    expect(el.innerHTML).toContain("flex-nowrap");
    expect(el.innerHTML).not.toContain("flex-wrap");
  });
});

describe("Fix It mode entry point (issue 810)", () => {
  it("renders prominent primary Fix It button when score is Needs Work (< 60)", () => {
    const onEnterFixIt = vi.fn();
    const score = { ...makeScore(), overall: 45 };
    const el = render(score, false, 5, onEnterFixIt);

    expect(el.textContent).toContain("5 things to fix");
    const btn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Fix It mode: 5 things to fix"]',
    )!;
    expect(btn).toBeDefined();
    expect(btn.className).toContain("bg-accent-primary");

    act(() => {
      btn.click();
    });
    expect(onEnterFixIt).toHaveBeenCalled();
  });

  it("renders quiet secondary Fix It affordance when score is Getting There (>= 60) with items", () => {
    const onEnterFixIt = vi.fn();
    const score = { ...makeScore(), overall: 75 };
    const el = render(score, false, 3, onEnterFixIt);

    expect(el.textContent).toContain("3 things to fix");
    const btn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Fix It mode: 3 things to fix"]',
    )!;
    expect(btn).toBeDefined();
    expect(btn.className).not.toContain("bg-accent-primary");
  });

  it("renders no count or button when guidance count is zero", () => {
    const onEnterFixIt = vi.fn();
    const score = { ...makeScore(), overall: 55 };
    const el = render(score, false, 0, onEnterFixIt);

    expect(el.textContent).not.toContain("things to fix");
    expect(el.textContent).not.toContain("Fix It");
  });

  it("carries the Fix It entry into the docked strip, in place of the dimension tiles", () => {
    const onEnterFixIt = vi.fn();
    const score = { ...makeScore(), overall: 45 };
    const el = render(score, true, 5, onEnterFixIt);

    const btn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Fix It mode: 5 things to fix"]',
    );
    expect(btn).not.toBeNull();
    // Same rung as the expanded readout: one action, not two.
    expect(btn!.className).toContain("bg-accent-primary");
    // The tiles would not fit beside it in the strip's fixed width budget.
    expect(el.querySelector('a[href="#contact"]')).toBeNull();

    act(() => {
      btn!.click();
    });
    expect(onEnterFixIt).toHaveBeenCalledTimes(1);
  });

  it("keeps the docked Fix It entry secondary at 60 and above", () => {
    const score = { ...makeScore(), overall: 75 };
    const el = render(score, true, 3, vi.fn());

    const btn = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Fix It mode: 3 things to fix"]',
    );
    expect(btn).not.toBeNull();
    expect(btn!.className).not.toContain("bg-accent-primary");
  });

  it("shows the dimension tiles in the docked strip when there is nothing to fix", () => {
    const el = render({ ...makeScore(), overall: 90 }, true, 0, vi.fn());

    expect(el.querySelector('button[aria-label^="Fix It mode"]')).toBeNull();
    expect(el.querySelector('a[href="#contact"]')).not.toBeNull();
  });
});

describe("Docked strip spacing (#680 item 8)", () => {
  it("sits Fix It right after the score pill and pins Score details right, with no justify-between", () => {
    const el = render({ ...makeScore(), overall: 45 }, true, 5, vi.fn());

    // The row no longer spreads its three groups with `justify-between` — a
    // fixed `gap-3` plus a trailing `ml-auto` replaces it (see
    // `CollapsedScoreBar`'s row comment).
    const expandButton = el.querySelector(
      'button[aria-label="Expand score details"]',
    );
    const trailingGroup = expandButton?.parentElement;
    const row = trailingGroup?.parentElement;
    expect(row?.className).not.toContain("justify-between");
    expect(row?.className).toContain("gap-3");

    // `ml-auto` is what pins the trailing Popover + "Score details" group to
    // the right edge now that the row itself is no longer `justify-between`.
    expect(trailingGroup?.className).toContain("ml-auto");
  });
});


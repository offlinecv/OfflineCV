// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The three invariants that make the score card's details region safe to dock
 * (#955), each of which fails silently if a later edit undoes it.
 *
 *  1. **Docking must not UNMOUNT the region.** The region holds a critique
 *     that cost a ~1.2 GB model download plus inference, and the docking
 *     trigger is a 4.5s idle timer — so "conditionally render it instead" is
 *     not a rare data loss, it is one per read. Asserted as node identity plus
 *     a mount counter, not as presence: `{!collapsed && children}` and
 *     `hidden={collapsed}` are indistinguishable by a `textContent` check
 *     while expanded, and the first one is the defect.
 *
 *  2. **Reading the region must HOLD the countdown.** `useAutoCollapse`'s
 *     docblock: "Collapsing content out from under someone who is still
 *     reading it is a defect," and hover AND focus both hold. That guarantee
 *     is only as wide as the element carrying `guardProps` — so this focuses a
 *     control INSIDE the details region, runs the timer past the deadline, and
 *     asserts the card is still open. A `guardProps` left on the hero alone
 *     passes every other test in this file.
 *
 *  3. **The region is a SIBLING of the hero `<section>`, never a child.**
 *     `e2e/support/score-hero.ts` resolves the hero as the toggle button's
 *     nearest `<section>` ancestor and `e2e/viewport.spec.ts` bounds its
 *     height at 200px; `measureDockedStrip` reads the docked row as that
 *     section's `:scope > div`. A details region nested inside it breaks all
 *     three at once, and only in Playwright. This asserts the same
 *     relationship in jsdom, where it is cheap.
 *
 * Raw `createRoot`, matching the other feature render tests. jsdom applies no
 * CSS, so "hidden" here is the ATTRIBUTE — which is the whole mechanism:
 * Tailwind's preflight makes `[hidden]` `display: none !important`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// The `Button` primitive, not a raw `<button>`: `src/components/**` is inside
// the forbid-elements lint scope, tests included.
import { Button } from "@design-system";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ScoreDetails } from "./ScoreDetails.tsx";
import { EXPAND_LABEL, COLLAPSE_LABEL } from "./scoreToggleLabels.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";

function makeScore(): AnonymousAtsScore {
  return {
    overall: 72,
    preLayoutOverall: 72,
    specificity: { score: 30, max: 40, gradable: true, metricBullets: 6, totalBullets: 10 },
    structure: {
      score: 24,
      max: 30,
      gradable: true,
      goodBullets: 8,
      verbLedBullets: 8,
      inWindowBullets: 8,
      totalBullets: 10,
    },
    completeness: { score: 18, max: 30, gradable: true, missing: ["phone"] },
    layout: { triggers: [], multiplier: 1, scanned: false },
    algoVersion: "test",
  } as unknown as AnonymousAtsScore;
}

/** Stands in for `ResumeQualityPanel`: expensive state that only exists
 *  because the panel has been mounted continuously. `mounts` is the proof —
 *  a remount resets `useState` too, so counting mounts and reading the state
 *  back are the same assertion made twice from different directions. */
let mounts = 0;
function ExpensiveChild() {
  const [critique] = useState(() => `critique #${++mounts}`);
  return createElement(
    "div",
    null,
    createElement("p", { id: "critique" }, critique),
    createElement(Button, { id: "in-details" }, "Apply"),
  );
}

let container: HTMLDivElement;
let root: Root;

function render(children = createElement(ExpensiveChild)) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(ScoreDetails, { score: makeScore() }, children));
  });
  return container;
}

/** The hero, resolved the way `e2e/support/score-hero.ts` resolves it: the
 *  toggle button's nearest `<section>` ancestor. Resolving it any other way
 *  would let this file pass while the spec's locator broke. */
function hero(el: HTMLElement): HTMLElement {
  const toggle = [...el.querySelectorAll("button")].find((b) =>
    [COLLAPSE_LABEL, EXPAND_LABEL].includes(b.getAttribute("aria-label") ?? ""),
  );
  if (!toggle) throw new Error("no score toggle button rendered");
  const section = toggle.closest("section");
  if (!section) throw new Error("score toggle has no <section> ancestor");
  return section;
}

/** The `hidden`-toggled details wrapper: the last child of `ScoreDetails`'
 *  root. Asserted to CONTAIN the children rather than assumed to — a throw
 *  here means the children were unmounted or reparented, which is itself the
 *  regression this file exists to catch, and a silent `null` would turn every
 *  assertion below into a vacuous one. */
function detailsRegion(el: HTMLElement): HTMLElement {
  const critique = el.querySelector("#critique");
  if (!critique) throw new Error("details children are not in the DOM at all");
  const region = el.firstElementChild?.lastElementChild as HTMLElement | null;
  if (!region || !region.contains(critique)) {
    throw new Error("the details children are not inside the last region");
  }
  return region;
}

function clickToggle(el: HTMLElement, label: string) {
  const btn = [...el.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!btn) throw new Error(`no button labelled ${label}`);
  act(() => btn.click());
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  mounts = 0;
});

describe("ScoreDetails — docking hides the details, it does not discard them", () => {
  it("keeps the children mounted, with their state, across a user dock", () => {
    const el = render();
    const before = el.querySelector("#critique");
    expect(before?.textContent).toBe("critique #1");
    expect(detailsRegion(el).hasAttribute("hidden")).toBe(false);

    clickToggle(el, COLLAPSE_LABEL);

    // Docked: the hero is the one-line strip…
    expect(el.textContent).toContain("Score details ▾");
    // …the region is hidden by ATTRIBUTE (`display: none !important` in a
    // browser, invisible to jsdom) …
    expect(detailsRegion(el).hasAttribute("hidden")).toBe(true);
    // …and the children are the SAME nodes, holding the SAME state. Node
    // identity is the part that catches a conditional render: presence alone
    // would be restored by a remount, which is the data loss.
    expect(el.querySelector("#critique")).toBe(before);
    expect(before?.textContent).toBe("critique #1");
    expect(mounts).toBe(1);
  });

  it("keeps them mounted across an AUTOMATIC dock too", () => {
    // The user-toggle path above is the rare one. The countdown is what fires
    // on nearly every parse, so it is the path that would actually be losing
    // the critique.
    vi.useFakeTimers();
    try {
      const el = render();
      const before = el.querySelector("#critique");
      act(() => {
        vi.advanceTimersByTime(4600);
      });
      expect(el.textContent).toContain("Score details ▾");
      expect(detailsRegion(el).hasAttribute("hidden")).toBe(true);
      expect(el.querySelector("#critique")).toBe(before);
      expect(mounts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reveals the same nodes when expanded again", () => {
    const el = render();
    const before = el.querySelector("#critique");
    clickToggle(el, COLLAPSE_LABEL);
    clickToggle(el, EXPAND_LABEL);
    expect(detailsRegion(el).hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("#critique")).toBe(before);
    expect(mounts).toBe(1);
  });
});

describe("ScoreDetails — the hold covers the details, not just the ring", () => {
  it("does not dock while focus is on a control inside the details region", () => {
    vi.useFakeTimers();
    try {
      const el = render();
      const inside = el.querySelector<HTMLButtonElement>("#in-details");
      expect(inside).not.toBeNull();
      act(() => inside!.focus());
      act(() => {
        vi.advanceTimersByTime(4600);
      });
      // Still expanded. With `guardProps` on the hero alone this reads
      // "Score details ▾" — the card docking out from under a reader who is
      // part-way through the findings.
      expect(el.textContent).toContain("Collapse ▴");
      expect(detailsRegion(el).hasAttribute("hidden")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes the countdown once focus leaves the whole group", () => {
    vi.useFakeTimers();
    try {
      const el = render();
      const inside = el.querySelector<HTMLButtonElement>("#in-details");
      act(() => inside!.focus());
      act(() => inside!.blur());
      act(() => {
        vi.advanceTimersByTime(2600);
      });
      expect(el.textContent).toContain("Score details ▾");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ScoreDetails — the details region is a sibling of the hero section", () => {
  it("never nests the details inside the hero's own <section> (#954 ceilings)", () => {
    const el = render();
    const critique = el.querySelector("#critique")!;
    expect(hero(el).contains(critique)).toBe(false);
    // …and the hero is not wrapped in a <section> of its own here either, so
    // `scoreCard()`'s one-ancestor walk still reaches the `Card` on `/`.
    expect(hero(el).parentElement?.tagName).toBe("DIV");
  });

  it("leaves the docked hero section with exactly one child div", () => {
    // `measureDockedStrip` reads the docked row as `section > :scope > div`.
    const el = render();
    clickToggle(el, COLLAPSE_LABEL);
    const section = hero(el);
    expect(section.children).toHaveLength(1);
    expect(section.firstElementChild?.tagName).toBe("DIV");
  });
});

describe("ScoreDetails — the focus-restore contract survives the lift (#953)", () => {
  it("moves focus to the counterpart toggle in both directions", () => {
    // The two states are separate subtrees, so activating a toggle unmounts
    // the button that was pressed. Without the restore a keyboard user drops
    // to `<body>` on every toggle, silently — `querySelector` returns null and
    // `?.focus()` no-ops. See `scoreToggleLabels.ts`.
    const el = render();
    clickToggle(el, COLLAPSE_LABEL);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      EXPAND_LABEL,
    );
    clickToggle(el, EXPAND_LABEL);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      COLLAPSE_LABEL,
    );
  });
});

describe("ScoreDetails — a region with nothing in it takes no space", () => {
  it("renders no child nodes, under the `empty:hidden` class", () => {
    // Every child self-hides, so "nothing to show" is an ordinary state — and
    // a zero-height flex item still earns its `gap-6`. `empty:hidden` is what
    // removes it, and it only works while the region is genuinely childless:
    // a stray `{" "}` or a placeholder node would defeat `:empty` silently.
    // Specificity 0,2,0 is what lets it beat the `flex` on the same element;
    // the `hidden` attribute is `!important` in preflight and beats both.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(ScoreDetails, { score: makeScore() }, false, null),
      );
    });
    const region = container.firstElementChild!.lastElementChild!;
    expect(region.childNodes).toHaveLength(0);
    expect([...region.classList]).toContain("empty:hidden");
  });
});

describe("ScoreDetails — the #313 reveal gate", () => {
  it("shows the placeholder and leaves the details OPEN with no score", () => {
    // No readout means no toggle, so a docked region would be unreachable.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          ScoreDetails,
          { score: null, placeholder: createElement("p", null, "not yet") },
          createElement(ExpensiveChild),
        ),
      );
    });
    expect(container.textContent).toContain("not yet");
    expect(container.querySelector("#critique")).not.toBeNull();
    expect(detailsRegion(container).hasAttribute("hidden")).toBe(false);
  });

  /** Mounts behind the gate, lets `wait` run while the author works toward
   *  the threshold, then reveals under the SAME `resetKey` — the authoring
   *  lane's `parseKey` does not move at the reveal. */
  function revealAfter(wait: () => void) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const at = (score: AnonymousAtsScore | null) =>
      act(() => {
        root.render(
          createElement(
            ScoreDetails,
            { score, resetKey: "authoring:1" },
            createElement(ExpensiveChild),
          ),
        );
      });
    at(null);
    act(wait);
    at(makeScore());
    return container;
  }

  it("does not dock BEFORE the reveal: the idle countdown starts at the reveal", () => {
    // #955 review: the countdown ran behind the gate, so a from-scratch
    // author who took longer than 4.5s got a readout that arrived docked and
    // a targeting region that vanished in the same render.
    vi.useFakeTimers();
    try {
      const el = revealAfter(() => vi.advanceTimersByTime(4600));
      expect(detailsRegion(el).hasAttribute("hidden")).toBe(false);
      expect(hero(el).textContent).not.toContain("Score details ▾");

      // …and the reveal is a real arrival: it still docks on its own clock.
      act(() => {
        vi.advanceTimersByTime(4600);
      });
      expect(detailsRegion(el).hasAttribute("hidden")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dock BEFORE the reveal on a scroll either", () => {
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
    try {
      const el = revealAfter(() => {
        scrollY.mockReturnValue(900);
        window.dispatchEvent(new Event("scroll"));
      });
      expect(detailsRegion(el).hasAttribute("hidden")).toBe(false);
      expect(hero(el).textContent).not.toContain("Score details ▾");
    } finally {
      scrollY.mockRestore();
    }
  });
});

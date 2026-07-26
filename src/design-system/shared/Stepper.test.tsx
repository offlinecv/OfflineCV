// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for `Stepper` (#602) — the four properties a consumer depends on and
 * that a refactor could silently break:
 *
 *  1. Inactive panels stay MOUNTED, only `hidden`. This is what lets a
 *     half-typed chip draft survive stepping away, so "renders nothing" would be
 *     a regression that no visual check catches.
 *  2. The current step carries `aria-current="step"` and exactly one does — the
 *     established pattern for an ordered progress trail, and the only thing
 *     telling a screen reader where the user is.
 *  3. The position is stated in WORDS, not left to the visual numerals.
 *  4. Back/Next move by one, and the terminal action is reachable from every
 *     step (see the component's docblock — a seeded query must be runnable
 *     without walking the whole flow).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Stepper, StepPanel, StepperNav, StepperRail } from "./Stepper.tsx";
import { Button } from "../primitives/Button.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STEPS = [
  { id: "one", label: "One", summary: "1 thing" },
  { id: "two", label: "Two", summary: "2 things" },
  { id: "three", label: "Three" },
];

let container: HTMLDivElement;
let root: Root;
let value: string;

function render(initial = "one", finalAction?: ReactNode) {
  value = initial;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(tree(finalAction)));
  return container;
}

function tree(finalAction?: ReactNode) {
  return createElement(Stepper, {
    id: "s",
    value,
    onValueChange: (next: string) => {
      value = next;
      act(() => root.render(tree(finalAction)));
    },
    steps: STEPS,
    children: [
      createElement(StepperRail, { key: "rail", "aria-label": "Steps" }),
      ...STEPS.map((s) =>
        createElement(StepPanel, { key: s.id, id: s.id, children: `body ${s.id}` }),
      ),
      createElement(StepperNav, { key: "nav", finalAction }),
    ],
  });
}

const panel = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`#s-steppanel-${id}`)!;
const buttonWithText = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("Stepper", () => {
  it("keeps every panel mounted and hides all but the current one", () => {
    const el = render("two");
    for (const s of STEPS) {
      // Mounted: the node and its children exist regardless of position.
      expect(panel(el, s.id).textContent).toBe(`body ${s.id}`);
    }
    expect(panel(el, "two").hidden).toBe(false);
    expect(panel(el, "one").hidden).toBe(true);
    expect(panel(el, "three").hidden).toBe(true);
  });

  it("marks exactly one step aria-current='step'", () => {
    const el = render("two");
    const current = el.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Two");
  });

  it("states the position in words, not only as numerals", () => {
    const el = render("two");
    expect(el.textContent).toContain("Step 2 of 3");
  });

  it("renders each step's summary when it has one, and nothing extra when it doesn't", () => {
    const el = render();
    expect(el.textContent).toContain("1 thing");
    expect(el.textContent).toContain("2 things");
    // "Three" has no summary — its rail entry is the label alone.
    const third = [...el.querySelectorAll('[role="listitem"], li')].find((n) =>
      n.textContent?.includes("Three"),
    );
    expect(third?.textContent?.trim()).toBe("3. Three");
  });

  it("moves one step at a time with Back and Next", () => {
    const el = render("one");
    // First step has no Back.
    expect(buttonWithText(el, "Back to")).toBeUndefined();

    act(() => buttonWithText(el, "Next: Two")!.click());
    expect(value).toBe("two");

    act(() => buttonWithText(container, "Back to One")!.click());
    expect(value).toBe("one");
  });

  it("drops Next on the last step but keeps the terminal action reachable from every step", () => {
    const action = createElement(Button, { children: "Do it" });
    const el = render("one", action);
    expect(buttonWithText(el, "Do it")).toBeDefined();

    act(() => buttonWithText(el, "Next: Two")!.click());
    act(() => buttonWithText(container, "Next: Three")!.click());
    expect(value).toBe("three");
    expect(buttonWithText(container, "Next:")).toBeUndefined();
    expect(buttonWithText(container, "Do it")).toBeDefined();
  });

  it("jumps to any step from the rail — the steps are all optional", () => {
    const el = render("one");
    const third = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Three"),
    )!;
    act(() => third.click());
    expect(value).toBe("three");
  });

  /** Arrow/Home/End on the rail. Keyboard is the only way some users move
   *  between steps, and it is invisible to every visual check — so it gets its
   *  own block rather than one representative key. */
  describe("keyboard", () => {
    function press(el: HTMLElement, key: string) {
      const nav = el.querySelector("nav")!;
      act(() => {
        nav.dispatchEvent(
          new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    }

    it("walks right and left one step at a time", () => {
      const el = render("one");
      press(el, "ArrowRight");
      expect(value).toBe("two");
      press(container, "ArrowLeft");
      expect(value).toBe("one");
    });

    it("wraps at both ends rather than dead-ending", () => {
      const el = render("one");
      press(el, "ArrowLeft");
      expect(value).toBe("three");
      press(container, "ArrowRight");
      expect(value).toBe("one");
    });

    it("jumps to the first and last step with Home and End", () => {
      const el = render("two");
      press(el, "End");
      expect(value).toBe("three");
      press(container, "Home");
      expect(value).toBe("one");
    });

    it("ignores a key it does not handle, leaving the step and the event alone", () => {
      const el = render("two");
      const nav = el.querySelector("nav")!;
      const event = new window.KeyboardEvent("keydown", {
        key: "a",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        nav.dispatchEvent(event);
      });
      expect(value).toBe("two");
      // Not swallowed — a typed character must still reach a field inside a panel.
      expect(event.defaultPrevented).toBe(false);
    });

    it("moves focus with the selection, so the next arrow press continues from there", () => {
      const el = render("one");
      press(el, "ArrowRight");
      expect(document.activeElement?.id).toBe("s-step-two");
    });
  });

  it("throws when a part is used outside the provider, rather than rendering a broken shell", () => {
    const orphan = document.createElement("div");
    const orphanRoot = createRoot(orphan);
    expect(() =>
      act(() => orphanRoot.render(createElement(StepPanel, { id: "x", children: null }))),
    ).toThrow(/must be used within <Stepper>/);
  });
});

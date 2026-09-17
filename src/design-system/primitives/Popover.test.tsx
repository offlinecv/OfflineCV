// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Behavioural tests for the click-triggered popover primitive (#953).
 *
 * Mirrors the dismiss contract `AchievementTypePicker`'s inline menu already
 * relies on (outside click, Escape, not inside click) since `Popover` lifts
 * that pattern verbatim — a regression here would silently regress that
 * pattern's one other consumer too.
 *
 * Also pins the focus contract, which is what makes the `role="dialog"` panel
 * reachable at all for a keyboard or screen-reader user: this primitive
 * replaced a native `<details>`/`<summary>`, so losing it would be a
 * regression rather than a missing nicety.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "./Button.tsx";
import { Popover } from "./Popover.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function renderNode(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return container;
}

function render() {
  return renderNode(
    <Popover label="How is this scored?" triggerContent={<span>ⓘ</span>}>
      <p data-testid="panel-body">Explanation text.</p>
    </Popover>,
  );
}

function trigger(el: HTMLElement): HTMLButtonElement {
  const button = el.querySelector("button");
  if (!button) throw new Error("no trigger button rendered");
  return button;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Popover", () => {
  it("renders a button trigger with dialog a11y wiring, panel absent while closed", () => {
    const el = render();
    const button = trigger(el);
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("How is this scored?");
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the panel on trigger click", () => {
    const el = render();
    act(() => trigger(el).click());
    expect(trigger(el).getAttribute("aria-expanded")).toBe("true");
    const panel = el.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-label")).toBe("How is this scored?");
    expect(el.querySelector('[data-testid="panel-body"]')).not.toBeNull();
  });

  it("closes on Escape", () => {
    const el = render();
    act(() => trigger(el).click());
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger(el).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on an outside click", () => {
    const el = render();
    act(() => trigger(el).click());
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it("moves focus into the panel when it opens", () => {
    const el = render();
    act(() => trigger(el).click());
    const panel = el.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    // Programmatically focusable, but deliberately out of the tab order.
    expect(panel?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(panel);
  });

  it("returns focus to the trigger when Escape closes it", () => {
    const el = render();
    act(() => trigger(el).click());
    expect(document.activeElement).toBe(el.querySelector('[role="dialog"]'));

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(el));
  });

  it("hands `close` to a function child, which dismisses the panel", () => {
    const el = renderNode(
      <Popover label="Pick one" triggerContent={<span>▾</span>}>
        {({ close }) => (
          <Button variant="ghost" onClick={close}>
            done
          </Button>
        )}
      </Popover>,
    );
    act(() => trigger(el).click());
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();

    // The open panel holds a button of its OWN — the shape that makes the
    // focus-restore selector load-bearing, since the picker's panel is a grid
    // of `role="menuitemradio"` buttons. `:scope > button` cannot reach it.
    expect(el.querySelectorAll("button")).toHaveLength(2);

    const done = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "done",
    );
    if (!done) throw new Error("function child did not render");
    act(() => done.click());
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    // Dismissing from inside still restores focus to the trigger, not to the
    // control that closed it — and the trigger is the root's DIRECT child,
    // which is the structural property the restore selector relies on.
    expect(document.activeElement).toBe(trigger(el));
    expect(trigger(el).parentElement).toBe(el.firstElementChild);
  });

  it("renders a non-default role, keeping the trigger's aria-haspopup in step", () => {
    const el = renderNode(
      <Popover
        role="menu"
        label="Type: Patent. Change it."
        panelLabel="Achievement type"
        triggerContent={<span>Patent</span>}
      >
        <p>choices</p>
      </Popover>,
    );
    expect(trigger(el).getAttribute("aria-haspopup")).toBe("menu");

    act(() => trigger(el).click());
    const panel = el.querySelector('[role="menu"]');
    expect(panel).not.toBeNull();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    // The trigger names the current value; the panel names the choice.
    expect(panel?.getAttribute("aria-label")).toBe("Achievement type");
    expect(trigger(el).getAttribute("aria-label")).toBe(
      "Type: Patent. Change it.",
    );
  });

  it("anchors the panel to the trigger's left edge by default", () => {
    const el = render();
    act(() => trigger(el).click());
    const panel = el.querySelector('[role="dialog"]')!;
    expect(panel.className).toContain("left-0");
    expect(panel.className).not.toContain("right-0");
  });

  it("anchors the panel to the trigger's RIGHT edge when aligned to the end", () => {
    // The docked score strip's ⓘ sits against the right edge, where a `left-0`
    // panel opens off-screen. `max-w` bounds the panel's WIDTH and cannot fix
    // that, and `className` cannot either — it appends, and there is no
    // `tailwind-merge`, so `left-0` from the base would still be in the list.
    const el = renderNode(
      <Popover
        align="end"
        label="How is this scored?"
        triggerContent={<span>ⓘ</span>}
      >
        <p>Explanation text.</p>
      </Popover>,
    );
    act(() => trigger(el).click());
    const panel = el.querySelector('[role="dialog"]')!;
    expect(panel.className).toContain("right-0");
    expect(panel.className).not.toContain("left-0");
  });

  it("does not close on a click inside the panel", () => {
    const el = render();
    act(() => trigger(el).click());
    const panel = el.querySelector('[role="dialog"]');
    if (!panel) throw new Error("panel did not open");

    act(() => {
      panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

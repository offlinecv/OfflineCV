// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Disclosure (#823) — and specifically the ONE property the callers depend on
 * that a reimplementation would silently drop.
 *
 * The panels this hides on `/` own effects: the degenerate-parse recovery panel
 * reports the recovered parse upward through one (#243), and
 * `SourceDiagnosticsPanel` re-rasterizes the source PDF on every mount. Swap
 * the native `<details>` for an overflow menu, or wrap the children in an
 * `open && …`, and both are unmounted whenever the section is shut — with no
 * error and no failing render test. So the mount assertion below is on node
 * IDENTITY across a close/open cycle, not on presence: a remount produces a
 * different element for the same child and presence alone cannot see it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Disclosure } from "./Disclosure.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<Parameters<typeof Disclosure>[0]> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(Disclosure, {
        summary: "Raw text & flags",
        children: createElement("p", { "data-testid": "panel" }, "panel body"),
        ...props,
      }),
    );
  });
  return container;
}

function details(el: HTMLElement): HTMLDetailsElement {
  const node = el.querySelector("details");
  if (!node) throw new Error("no <details> rendered");
  return node;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("Disclosure", () => {
  it("keeps its children mounted through a close/open cycle", () => {
    const el = render({ defaultOpen: true });
    const panel = el.querySelector('[data-testid="panel"]');
    expect(panel).not.toBeNull();

    // Driven through the summary rather than by assigning `details.open`: the
    // property assignment does not notify React, so the `act` block would be
    // inert and an `onToggle`-gated rewrite of this component — the exact change
    // this test exists to forbid — would sail through green.
    const summary = el.querySelector("summary");
    if (!summary) throw new Error("no summary row");

    act(() => summary.click());
    expect(details(el).open).toBe(false);
    // Still in the document while shut — this is the whole contract.
    expect(el.querySelector('[data-testid="panel"]')).toBe(panel);

    act(() => summary.click());
    expect(details(el).open).toBe(true);
    expect(el.querySelector('[data-testid="panel"]')).toBe(panel);
  });

  it("starts collapsed, with its children already mounted", () => {
    const el = render();
    expect(details(el).open).toBe(false);
    expect(el.querySelector('[data-testid="panel"]')).not.toBeNull();
  });

  it("opens for a keyboard user through the native summary control", () => {
    // No `aria-expanded` to maintain and no key handler to write: `<summary>`
    // is focusable and Enter/Space-activatable by the UA, which is half the
    // reason this is not a `<Button>` + a div.
    const el = render();
    const summary = el.querySelector("summary");
    if (!summary) throw new Error("no <summary> rendered");
    expect(summary.tabIndex).toBe(0);
    act(() => summary.click());
    expect(details(el).open).toBe(true);
  });

  it("renders the count on the summary row, and nothing at zero", () => {
    expect(render({ count: 3 }).querySelector("summary")?.textContent).toContain(
      "3",
    );
    act(() => root.unmount());
    container.remove();
    // A caller passes `count` unconditionally; an empty badge must not appear.
    expect(render({ count: 0 }).querySelector("summary")?.textContent).toBe(
      "▸Raw text & flags",
    );
  });

  it("announces what the warn mark means, so it is never colour alone", () => {
    const el = render({ warn: true, warnLabel: "setup needed" });
    const summary = el.querySelector("summary");
    expect(summary?.textContent).toContain("setup needed");
    expect(summary?.querySelector(".sr-only")?.textContent).toBe(
      " (setup needed)",
    );
  });
});

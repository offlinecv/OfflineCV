// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `useArrivedFromRoot` — the marker's lifetime is ONE visit, not one click.
 *
 * The defect (#706 follow-up): the marker records only WHERE a trip started,
 * so consuming it at click time let `/`'s marker outlive the leg it was
 * written for and answer whichever back control the user reached next (the
 * two-hop bug fixed with a second surface's removal in #576). These tests pin both
 * halves of the fix at the hook boundary — consumption happens at MOUNT even
 * when no control is ever clicked, and the answer is captured for the visit —
 * and the StrictMode assertion is the one that would go red if the read and
 * the clear were ever folded back into a single lazy initializer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useArrivedFromRoot } from "./useArrivedFromRoot.ts";
import { markDeparture } from "../lib/nav-return.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

/** Mount a probe that renders the hook's answer, optionally under StrictMode. */
function mount(strict = false): () => string | null {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const Probe = () => String(useArrivedFromRoot());
  act(() => {
    root.render(
      strict
        ? createElement(StrictMode, null, createElement(Probe))
        : createElement(Probe),
    );
  });
  return () => container.textContent;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("useArrivedFromRoot", () => {
  it("reports the root marker and retires it at mount, with no click involved", () => {
    markDeparture();
    const answer = mount();
    expect(answer()).toBe("true");
    // The half that fixes the two-hop bug: the next surface must find nothing.
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
  });

  it("reports false for a visit that was never marked", () => {
    expect(mount()()).toBe("false");
  });

  it("retires a NON-root marker too, without claiming it", () => {
    markDeparture({ pathname: "/jobs/" });
    const answer = mount();
    expect(answer()).toBe("false");
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
  });

  it("still answers true under StrictMode's double-invoked render", () => {
    // React double-invokes a component's render on mount in dev and keeps the
    // SECOND pass's hook state. A lazy initializer that cleared storage would
    // answer `true` then `false`, and the `false` would win — the feature would
    // be dead under `npm run dev` while every non-Strict test stayed green.
    // Splitting the pure read (initializer) from the idempotent clear (effect)
    // is what makes both passes agree.
    markDeparture();
    const answer = mount(true);
    expect(answer()).toBe("true");
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
  });
});

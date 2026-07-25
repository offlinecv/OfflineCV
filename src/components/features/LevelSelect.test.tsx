// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for LevelSelect (#568). Raw createRoot + act, matching the
 * other feature render tests in this lane (no @testing-library here).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LevelSelect } from "./LevelSelect.tsx";
import { SENIORITY_LADDER } from "../../lib/job-search/seniority.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(value: string | undefined, onChange: (v: string | undefined) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(LevelSelect, { value, onChange }));
  });
  return container;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("LevelSelect", () => {
  it("renders one radio option per SENIORITY_LADDER label", () => {
    const el = render(undefined, () => {});
    const radios = el.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(Object.keys(SENIORITY_LADDER).length);
    expect(el.textContent).toContain("Senior");
    expect(el.textContent).toContain("Executive");
  });

  it("marks the current value's option as checked and no Clear button when unset", () => {
    const el = render(undefined, () => {});
    expect(el.querySelectorAll('button[aria-label="Clear"], a[aria-label="Clear"]').length).toBe(0);
    const checked = [...el.querySelectorAll('[role="radio"]')].filter(
      (n) => n.getAttribute("aria-checked") === "true",
    );
    expect(checked.length).toBe(0);
  });

  it("selecting a level calls onChange with that level", () => {
    let selected: string | undefined;
    const el = render(undefined, (v) => {
      selected = v;
    });
    const senior = [...el.querySelectorAll('[role="radio"]')].find(
      (n) => n.textContent === "Senior",
    ) as HTMLButtonElement;
    act(() => senior.click());
    expect(selected).toBe("Senior");
  });

  it("selecting the already-active level clears it (toggle-to-clear)", () => {
    let selected: string | undefined = "Senior";
    const el = render("Senior", (v) => {
      selected = v;
    });
    const senior = [...el.querySelectorAll('[role="radio"]')].find(
      (n) => n.textContent === "Senior",
    ) as HTMLButtonElement;
    expect(senior.getAttribute("aria-checked")).toBe("true");
    act(() => senior.click());
    expect(selected).toBeUndefined();
  });

  it("shows a Clear control when a level is set, which clears the value", () => {
    let selected: string | undefined = "Staff";
    const el = render("Staff", (v) => {
      selected = v;
    });
    const clear = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear",
    ) as HTMLButtonElement;
    expect(clear).toBeTruthy();
    act(() => clear.click());
    expect(selected).toBeUndefined();
  });
});

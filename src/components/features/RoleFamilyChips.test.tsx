// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for RoleFamilyChips (#568). Raw createRoot + act, matching
 * the other feature render tests in this lane (no @testing-library here).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoleFamilyChips } from "./RoleFamilyChips.tsx";
import type { RoleFamily } from "../../lib/job-search/role-keywords.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(families: RoleFamily[], onRemove: (f: RoleFamily) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(RoleFamilyChips, { families, onRemove }));
  });
  return container;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RoleFamilyChips", () => {
  it("renders one removable chip per family", () => {
    const el = render(["frontend", "data"], () => {});
    expect(el.textContent).toContain("frontend");
    expect(el.textContent).toContain("data");
    expect(el.querySelectorAll('button[aria-label="Remove frontend"]').length).toBe(1);
    expect(el.querySelectorAll('button[aria-label="Remove data"]').length).toBe(1);
  });

  it("calls onRemove with the clicked family", () => {
    const removed: RoleFamily[] = [];
    const el = render(["frontend", "data"], (f) => removed.push(f));
    const button = el.querySelector(
      'button[aria-label="Remove data"]',
    ) as HTMLButtonElement;
    act(() => button.click());
    expect(removed).toEqual(["data"]);
  });

  it("never fails closed: an empty family list shows a notice, not an empty/broken row", () => {
    const el = render([], () => {});
    expect(el.textContent).toContain("No role narrowing");
    expect(el.querySelectorAll("button").length).toBe(0);
  });
});

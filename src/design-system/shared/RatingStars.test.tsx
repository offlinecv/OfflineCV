// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RatingStars } from "./RatingStars.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(props: Parameters<typeof RatingStars>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(RatingStars, props)));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

/** The fill overlay is the second star row (the clipped, accent-coloured one). */
function fillWidth(el: HTMLElement): string {
  const overlay = el.querySelector('[aria-hidden="true"].absolute') as HTMLElement;
  return overlay.style.width;
}

describe("RatingStars", () => {
  it("exposes one role=img with a numeric aria-label; glyphs are hidden", () => {
    const el = render({ value: 4.2 });
    const img = el.querySelector('[role="img"]') as HTMLElement;
    expect(img.getAttribute("aria-label")).toBe("4.2 out of 5 stars");
    // Every star glyph span is aria-hidden — AT reads the label, not ten stars.
    for (const g of el.querySelectorAll("span[aria-hidden]")) {
      expect(g.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("fills the overlay to (value / max) · 100%", () => {
    expect(fillWidth(render({ value: 4.2 }))).toBe("84%"); // 4.2 / 5
    expect(fillWidth(render({ value: 2.5 }))).toBe("50%");
    expect(fillWidth(render({ value: 0 }))).toBe("0%");
    expect(fillWidth(render({ value: 5 }))).toBe("100%");
  });

  it("honours a custom max in both the label and the fill", () => {
    const el = render({ value: 3, max: 10 });
    expect((el.querySelector('[role="img"]') as HTMLElement).getAttribute("aria-label")).toBe(
      "3 out of 10 stars",
    );
    expect(fillWidth(el)).toBe("30%");
  });

  it("clamps an out-of-range value into [0, max]", () => {
    expect(fillWidth(render({ value: 9 }))).toBe("100%");
    expect(fillWidth(render({ value: -3 }))).toBe("0%");
  });

  it("prints no numeral by default and a one-decimal, aria-hidden one with showValue", () => {
    expect(render({ value: 4.2 }).textContent).not.toContain("4.2");

    const el = render({ value: 4.2, showValue: true });
    const numeral = [...el.querySelectorAll("span")].find(
      (s) => s.textContent === "4.2",
    ) as HTMLElement;
    expect(numeral).toBeTruthy();
    // The aria-label already says "4.2 out of 5 stars" — AT must not hear it twice.
    expect(numeral.getAttribute("aria-hidden")).toBe("true");
    // A whole value still shows a decimal, so the column width does not jitter.
    expect(render({ value: 4, showValue: true }).textContent).toContain("4.0");
  });

  it("keeps the fill measured against the stars alone when a numeral is shown", () => {
    // Regression guard: a numeral inside the overlay's positioning box would
    // widen it and under-fill every rating.
    expect(fillWidth(render({ value: 4.2, showValue: true }))).toBe("84%");
  });

  it("rounds the label to one decimal but a custom label wins verbatim", () => {
    expect(
      (render({ value: 3.14159 }).querySelector('[role="img"]') as HTMLElement).getAttribute(
        "aria-label",
      ),
    ).toBe("3.1 out of 5 stars");
    expect(
      (
        render({ value: 4, ariaLabel: "Overall match: 4 out of 5 stars" }).querySelector(
          '[role="img"]',
        ) as HTMLElement
      ).getAttribute("aria-label"),
    ).toBe("Overall match: 4 out of 5 stars");
  });
});

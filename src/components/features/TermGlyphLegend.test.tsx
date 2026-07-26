// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The legend's job is to make four marks readable (#597), so what is worth
 * asserting is the PAIRING — every glyph the chips can render appears here next
 * to words, and the words are what a screen reader gets. A test that only
 * counted spans would pass on a legend that showed the glyphs alone, which is
 * the exact failure the component exists to prevent.
 *
 * The copy denylist lives in `job-search-copy.test.ts` with the other surfaces'.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QUALITY_MARK } from "./ChipListEditor.tsx";
import { TermGlyphLegend } from "./TermGlyphLegend.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root | undefined;

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(TermGlyphLegend));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("TermGlyphLegend", () => {
  it("shows every quality mark the chips can render", () => {
    const el = render();
    for (const { glyph } of Object.values(QUALITY_MARK)) {
      expect(el.textContent).toContain(glyph);
    }
    expect(el.textContent).toContain("★");
  });

  it("pairs each glyph with words, so meaning is never the mark alone", () => {
    const el = render();
    // Every glyph is aria-hidden — the accessible text is the sentence beside
    // it. Strip the hidden nodes and the legend must still say everything.
    for (const hidden of el.querySelectorAll("[aria-hidden='true']")) {
      hidden.remove();
    }
    const readable = el.textContent ?? "";
    expect(readable).toContain("the one that is searched");
    expect(readable).toContain("sharpens your matches");
    expect(readable).toContain("adds little");
    expect(readable).toContain("narrows nothing");
    for (const { glyph } of Object.values(QUALITY_MARK)) {
      expect(readable).not.toContain(glyph);
    }
  });
});

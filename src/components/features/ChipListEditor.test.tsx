// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural test for the promote control's expanded hit area (#591). Same
 * jsdom caveat as `design-system/primitives/Chip.test.tsx`: no layout engine,
 * so this asserts the CSS technique (an invisible vertical-only `after:`
 * overlay) is present rather than measuring rendered pixels. Real-browser
 * measurement is recorded in #591.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChipListEditor } from "./ChipListEditor.tsx";

function render(props: Parameters<typeof ChipListEditor>[0]): string {
  return renderToStaticMarkup(createElement(ChipListEditor, props));
}

describe("ChipListEditor promote control target size", () => {
  it("expands the non-primary promote control's hit area vertically to reach 24x24, without a horizontal overlay that could cross into the remove control", () => {
    const html = render({
      label: "Titles",
      items: ["Frontend Engineer", "Fullstack Engineer"],
      onAdd: () => {},
      onRemove: () => {},
      placeholder: "Add a title",
      addAriaLabel: "Add title",
      primaryIndex: 0,
      onPromote: () => {},
    });
    // The ~16px-tall `Button variant="link"` promote control gets a 4px
    // vertical-only overlay (16 + 4 + 4 = 24) — `after:inset-x-0` keeps the
    // horizontal edges unchanged so the overlay can't reach across the 4px
    // `gap-1` into the neighbouring remove control's hit area.
    expect(html).toContain("after:-inset-y-[4px]");
    expect(html).toContain("after:inset-x-0");
  });

  it("renders the primary chip's star mark without a promote control", () => {
    const html = render({
      label: "Titles",
      items: ["Frontend Engineer"],
      onAdd: () => {},
      onRemove: () => {},
      placeholder: "Add a title",
      addAriaLabel: "Add title",
      primaryIndex: 0,
      onPromote: () => {},
    });
    expect(html).toContain('aria-current="true"');
  });
});

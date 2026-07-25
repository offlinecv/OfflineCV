// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural test for the `Chip` remove control's expanded hit area (#591).
 * jsdom does not do layout — `getBoundingClientRect()` returns zeros here, so
 * a real pixel measurement is NOT possible in this suite (see the actual
 * browser measurement recorded in #591 instead). This asserts the CSS
 * technique that produces the 24x24 CSS px hit area is present — an invisible
 * `after:` overlay inset -5px on every side around the ~14px visible control
 * — as a structural proxy, not a rendered measurement. Matches
 * `EditableField.test.tsx`'s `renderToStaticMarkup` pattern; no jsdom needed.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip } from "./Chip.tsx";

function render(props: Parameters<typeof Chip>[0]): string {
  return renderToStaticMarkup(createElement(Chip, props));
}

describe("Chip remove control target size", () => {
  it("expands the remove control's hit area to 24x24 via an invisible overlay, not a layout change", () => {
    const html = render({
      children: "React",
      onRemove: () => {},
      removeLabel: "Remove React",
    });
    // `relative` positions the button as the overlay's containing block;
    // `after:-inset-[5px]` grows the clickable area 5px on every side of the
    // ~14px visible control (14 + 5 + 5 = 24), meeting WCAG 2.2 SC 2.5.8 (AA)
    // without touching the button's own visual box.
    expect(html).toContain("relative");
    expect(html).toContain("after:-inset-[5px]");
    expect(html).toContain("after:content-[&#x27;&#x27;]");
  });
});

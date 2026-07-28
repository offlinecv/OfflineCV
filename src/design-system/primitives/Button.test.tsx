// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural test pinning the `icon` variant's 24x24 CSS-px touch-target
 * floor (WCAG 2.2 AA SC 2.5.8, #638). jsdom does not do layout —
 * `getBoundingClientRect()` returns zeros here, so a real pixel measurement
 * is NOT possible in this suite (see the actual browser measurement recorded
 * for `Chip` in #591). This asserts the CSS technique itself is present: a
 * fixed, centred invisible `after:` overlay (`h-6 w-6`, `left-1/2 top-1/2`
 * `-translate-x-1/2 -translate-y-1/2`) on a `relative` button — NOT an
 * inset-based overlay, which would scale with (and overshoot) a caller's own
 * `h-`/`w-` sizing (see `Button.tsx`'s docblock). A future token edit that
 * drops `relative`, the fixed `h-6 w-6`, or the centring classes fails this
 * test even though every existing snapshot/behavioural test stays green,
 * because none of them can see an invisible overlay. Matches
 * `Chip.test.tsx`'s `renderToStaticMarkup` pattern; no jsdom needed.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./Button.tsx";

function render(props: Parameters<typeof Button>[0]): string {
  return renderToStaticMarkup(createElement(Button, props));
}

describe("Button icon variant target size", () => {
  it("carries a fixed, centred 24x24 invisible overlay on top of its own ~14px box", () => {
    const html = render({ variant: "icon", "aria-label": "Remove" });
    expect(html).toContain("relative");
    // `after:absolute` is load-bearing, not decoration: without it the
    // pseudo-element is a non-replaced INLINE box, where `width`/`height` do
    // not apply at all. Drop it and the overlay silently becomes a no-op while
    // every `after:h-6`/`after:w-6` assertion below still passes.
    expect(html).toContain("after:absolute");
    expect(html).toContain("after:h-6");
    expect(html).toContain("after:w-6");
    expect(html).toContain("after:left-1/2");
    expect(html).toContain("after:top-1/2");
    expect(html).toContain("after:-translate-x-1/2");
    expect(html).toContain("after:-translate-y-1/2");
    expect(html).toContain("after:content-[&#x27;&#x27;]");
  });

  it("does not carry the overlay on other variants", () => {
    const html = render({ variant: "ghost", children: "Cancel" });
    expect(html).not.toContain("after:h-6");
    expect(html).not.toContain("after:w-6");
  });
});

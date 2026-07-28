// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural test for the `Chip` remove control's visible box (#591, #638).
 * jsdom does not do layout — `getBoundingClientRect()` returns zeros here, so
 * a real pixel measurement is NOT possible in this suite (see the actual
 * browser measurement recorded in #591 instead). The 24x24 hit-area floor
 * itself now lives on the `icon` Button variant and is pinned by
 * `Button.test.tsx` — this test only guards that `Chip` stays a plain
 * consumer of that variant and does not reintroduce its own redundant
 * `min-h`/`min-w`/overlay, which would double up on (or fight) the
 * primitive's own floor. Matches `EditableField.test.tsx`'s
 * `renderToStaticMarkup` pattern; no jsdom needed.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip } from "./Chip.tsx";

function render(props: Parameters<typeof Chip>[0]): string {
  return renderToStaticMarkup(createElement(Chip, props));
}

describe("Chip remove control target size", () => {
  it("keeps the remove control's own box unexpanded, relying on the icon variant's floor", () => {
    const html = render({
      children: "React",
      onRemove: () => {},
      removeLabel: "Remove React",
    });
    // POSITIVE assertion first, and it is the load-bearing one: it pins that
    // Chip is still an `icon`-variant CONSUMER. `Button` defaults to
    // `variant = "ghost"`, so deleting the one `variant="icon"` token in
    // Chip.tsx would drop the whole SC 2.5.8 floor — and `ghost` and `icon`
    // render near-identically in jsdom, so an all-negative test would stay
    // green through exactly that edit. The overlay classes only ever reach the
    // markup via the `icon` variant, so asserting one of them asserts the
    // variant.
    expect(html).toContain("after:absolute");
    expect(html).toContain("after:h-6");
    // No per-caller min-h/min-w/overlay — the `icon` variant supplies the
    // 24x24 floor (see Button.test.tsx). These stay NEGATIVE: their job is to
    // catch a reintroduced per-caller mechanism that would double up on (or
    // fight) the primitive's floor.
    expect(html).not.toContain("min-h-6");
    expect(html).not.toContain("min-w-6");
    expect(html).not.toContain("after:-inset-[5px]");
  });
});

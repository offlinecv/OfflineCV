// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural test pinning `RemoveButton`'s VISIBLE 24×24 box (#638 review).
 *
 * `Button.test.tsx` pins the `icon` variant's invisible `after:` overlay — the
 * TOUCH TARGET. That overlay is fixed at 24×24 and centred, so it says nothing
 * about the size of the box the user can SEE, and it reads as making a caller's
 * `min-h-6 min-w-6` redundant. It is not: #638 deleted that minimum on exactly
 * that reasoning, which shrank the painted `hover:bg-surface-subtle` rectangle
 * and the `focus-visible` ring from 24×24 to ~14×14 at all eight `RemoveButton`
 * call sites, and — because a 14px box under a fixed 24px overlay overhangs 5px
 * per side, wider than the `gap-1` (4px) in `ReconstructedRole`'s and
 * `ContactExtraLinks`' action rows — reintroduced the #581/#591 neighbour-target
 * overlap the overlay was designed to avoid.
 *
 * A docblock alone did not survive that round, so the invariant is asserted
 * here. jsdom does no layout (`getBoundingClientRect()` is all zeros), so this
 * asserts the classes, not measured pixels — same limitation and same
 * `renderToStaticMarkup` pattern as `Button.test.tsx` and `Chip.test.tsx`.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddPill, InlineBulletAdd, RemoveButton } from "./ReconstructedAdd.tsx";

describe("RemoveButton visible box (#638 review)", () => {
  const html = renderToStaticMarkup(
    createElement(RemoveButton, { label: "Remove role", onClick: () => {} }),
  );

  it("sizes its own visible box to the 24x24 the overlay targets", () => {
    // Zero overflow depends on the visible box being >= the fixed 24x24
    // overlay. Dropping either class is the regression this pins.
    expect(html).toContain("min-h-6");
    expect(html).toContain("min-w-6");
  });

  it("still routes through the icon variant that owns the touch target", () => {
    // The minimum above is additive to the overlay, never a replacement for
    // it — if the variant were swapped out, the target floor would be lost on
    // any caller that did not repeat the sizing.
    expect(html).toContain("after:h-6");
    expect(html).toContain("after:w-6");
    expect(html).toContain("relative");
  });
});

describe("edit chrome at rest (#913)", () => {
  // The stylesheet (`design-system/styles/edit-chrome.css`) does the hiding;
  // these pin that the shared add/remove controls opt into it, so every
  // section that reuses them rests clean without a class of its own.
  it("marks RemoveButton, AddPill and InlineBulletAdd's collapsed pill as edit chrome", () => {
    for (const node of [
      createElement(RemoveButton, { label: "Remove role", onClick: () => {} }),
      createElement(AddPill, { label: "Add experience", onClick: () => {} }),
      createElement(InlineBulletAdd, { onAdd: () => {} }),
    ]) {
      expect(renderToStaticMarkup(node)).toMatch(/^<button[^>]*class="[^"]*\bedit-chrome\b/u);
    }
  });

  it("floats a pill out of flow only when asked, at the requested spot", () => {
    // A pill on its own row reserves a blank line at rest; `float` is how a
    // section or entry opts out of that (styles/edit-chrome.css `edit-float`).
    const plain = renderToStaticMarkup(
      createElement(AddPill, { label: "Add project", onClick: () => {} }),
    );
    expect(plain).not.toContain("edit-float");
    const heading = renderToStaticMarkup(
      createElement(AddPill, { label: "Add project", onClick: () => {}, float: "heading" }),
    );
    expect(heading).toMatch(/\bedit-float\b[^"]*\bright-0\b[^"]*\btop-0\b/u);
    const below = renderToStaticMarkup(
      createElement(InlineBulletAdd, { onAdd: () => {}, float: "below" }),
    );
    expect(below).toMatch(/\bedit-float\b[^"]*\bleft-0\b[^"]*\btop-full\b/u);
    // Shorter only where it floats: a coarse pointer keeps it in flow at the
    // in-flow pill's height.
    for (const markup of [heading, below]) {
      expect(markup).toMatch(/\bpy-1\b[^"]*\bpointer-fine:py-0\.5\b/u);
    }
  });
});

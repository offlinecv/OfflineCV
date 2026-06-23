// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Smoke tests for the `Dialog` primitive.
 *
 * The repo's component tests run in the Node env via `renderToStaticMarkup`
 * (no jsdom, no react-testing-library) so we can't drive the browser's
 * `showModal()` lifecycle here. These tests cover the React surface that is
 * observable from server-side render: structural ARIA wiring, title vs
 * aria-label fallback, and that children are rendered inside the dialog.
 *
 * Browser-driven behavior (focus trap, Esc closes, ::backdrop overlay) is
 * provided by the native `<dialog>` element and asserted via the manual
 * verification step in the PR test plan.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "./Dialog.tsx";

function render(props: Parameters<typeof Dialog>[0]): string {
  return renderToStaticMarkup(createElement(Dialog, props));
}

describe("Dialog", () => {
  it("renders a native <dialog> with the children", () => {
    const html = render({
      open: true,
      onClose: () => {},
      ariaLabel: "Test dialog",
      children: createElement("p", null, "hello world"),
    });
    expect(html).toContain("<dialog");
    expect(html).toContain("hello world");
  });

  it("pairs the title heading with aria-labelledby (accessible name comes from the heading)", () => {
    const html = render({
      open: true,
      onClose: () => {},
      title: "Confirm something",
      children: createElement("p", null, "body"),
    });
    // The same id is referenced by aria-labelledby and used on the heading.
    const labelledByMatch = html.match(/aria-labelledby="([^"]+)"/);
    expect(labelledByMatch).not.toBeNull();
    const id = labelledByMatch![1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain("Confirm something");
    // When a title is present, the dialog must NOT also have an aria-label —
    // duplicating breaks screen-reader announcement.
    expect(html).not.toMatch(/aria-label="[^"]+"/);
  });

  it("falls back to aria-label when no title is provided", () => {
    const html = render({
      open: true,
      onClose: () => {},
      ariaLabel: "Standalone dialog",
      children: createElement("p", null, "body"),
    });
    expect(html).toContain('aria-label="Standalone dialog"');
    expect(html).not.toMatch(/aria-labelledby="/);
  });

  it("merges caller className with the owned chrome", () => {
    const html = render({
      open: true,
      onClose: () => {},
      ariaLabel: "x",
      className: "my-layout-class",
      children: createElement("p", null, "body"),
    });
    expect(html).toContain("my-layout-class");
    // The owned chrome (rounded-xl etc.) still survives the merge.
    expect(html).toContain("rounded-xl");
    expect(html).toContain("bg-surface-card");
  });

  it("includes a backdrop-styling class so the overlay theme follows tokens, not raw palette", () => {
    const html = render({
      open: true,
      onClose: () => {},
      ariaLabel: "x",
      children: createElement("p", null, "body"),
    });
    // Tailwind backdrop:* utility is observable in the rendered class list.
    expect(html).toMatch(/backdrop:bg-content-primary/);
  });
});

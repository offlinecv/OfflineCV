// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render and interaction tests for RolesPanel (#599).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RolesPanel } from "./RolesPanel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(
  titles: string[],
  primary?: string,
  onPrimaryChange: (val: string) => void = () => {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(RolesPanel, { titles, primary, onPrimaryChange }),
    );
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    container.remove();
  }
});

function expectPrimary(el: Element, expectedText: string) {
  const primaryEl = el.querySelector('[aria-current="true"]');
  expect(primaryEl).not.toBeNull();
  expect(primaryEl?.textContent).toContain("★");
  expect(primaryEl?.textContent).toContain(expectedText);
}

describe("RolesPanel", () => {
  it("renders nothing when titles is empty", () => {
    const el = render([]);
    expect(el.firstElementChild).toBeNull();
  });

  // #605 review: this used to assert `titles[0]` was starred by default, which
  // was the defect — `render-ats-pdf.ts` guards on `model.contact.headline`, so
  // with no headline the export draws NOTHING under the name while the ★ and
  // its copy claimed otherwise. Only 8 of 54 corpus fixtures parse a headline,
  // so the over-claim hit ~85% of the corpus. No headline → no ★.
  it("marks no title as primary when there is no headline at all", () => {
    const el = render(["Engineering Lead", "Senior Developer"]);
    expect(el.textContent).toContain("Engineering Lead");
    expect(el.textContent).toContain("Senior Developer");

    expect(el.querySelector('[aria-current="true"]')).toBeNull();
    expect(el.textContent).toContain(
      "Nothing picked yet, so no role prints under your name.",
    );
    // Every chip is a promote control in this state — including the first.
    expect(
      el.querySelector('button[aria-label="Make Engineering Lead the primary title"]'),
    ).not.toBeNull();
  });

  it("marks the specified primary title when primary is set", () => {
    const el = render(
      ["Engineering Lead", "Senior Developer"],
      "Senior Developer",
    );
    expectPrimary(el, "Senior Developer");
  });

  it("calls onPrimaryChange with title when a non-primary title is clicked", () => {
    let chosen = "";
    const el = render(
      ["Engineering Lead", "Senior Developer"],
      "Engineering Lead",
      (val) => {
        chosen = val;
      },
    );

    const button = el.querySelector(
      'button[aria-label="Make Senior Developer the primary title"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => button.click());
    expect(chosen).toBe("Senior Developer");
  });

  // BOTH consequences of promoting must be stated, and the egress one is the
  // load-bearing half: `titles[0]` is what `providers/keywords.ts` sends as the
  // feeds' `search=` param. Assert each clause separately — a single
  // `toContain` over the shared "prints under your name" substring would stay
  // green if the egress sentence were dropped.
  it("states both consequences of promoting a title", () => {
    const el = render(["Engineering Lead"]);
    // Collapse whitespace: JSX line-wrapping puts newlines + indentation inside
    // these sentences, so a raw `textContent` match would be asserting the
    // source's formatting rather than the copy.
    const text = (el.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("print it under your name on the PDF you download");
    expect(text).toContain("A single title is sent to the job feeds");
    expect(text).toContain("The rest stay on your device");
    // The egress happens with or without a pick — `titles[0]` is sent either
    // way — so the copy must not condition it on picking (#605 review).
    expect(text).not.toContain("only title sent to the job feeds");
  });

  it("reports a headline that is not one of the chips instead of claiming nothing prints", () => {
    const el = render(["Engineering Lead", "Senior Developer"], "CTO");
    // Not one of the chips, so no ★ — but it DOES print, so the empty-state
    // sentence would be a false claim here.
    expect(el.querySelector('[aria-current="true"]')).toBeNull();
    expect(el.textContent).toContain("CTO");
    expect(el.textContent).toContain("prints under your name right now");
    expect(el.textContent).not.toContain(
      "Nothing picked yet, so no role prints under your name.",
    );
  });
});

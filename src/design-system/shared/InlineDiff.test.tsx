// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `noChangeLabel` (#778) is the only branch in `InlineDiff` — everything else
 * is a straight map over segments — and it is the branch that decides whether
 * a rejected rewrite reads as "nothing happened" or as "this was declined".
 *
 * jsdom via the pragma, raw `createRoot`, matching the feature-component tests.
 */

import { describe, expect, it, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { InlineDiff } from "./InlineDiff.tsx";
import { computeTextDiff } from "../../lib/diff/text-diff.ts";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("InlineDiff", () => {
  it("renders every segment in order", () => {
    const el = render(
      createElement(InlineDiff, {
        segments: computeTextDiff("Cut latency 40%.", "Cut p99 latency 40%."),
      }),
    );
    expect(el.textContent).toContain("40%");
    expect(el.querySelectorAll("span").length).toBeGreaterThan(1);
  });

  it("shows `noChangeLabel` when the two sides are identical", () => {
    const el = render(
      createElement(InlineDiff, {
        segments: computeTextDiff("Cut latency 40%.", "Cut latency 40%."),
        noChangeLabel: "No changes applied — your original bullets.",
      }),
    );
    expect(el.textContent).toContain("No changes applied");
  });

  it("hides `noChangeLabel` the moment there is a real change to show", () => {
    // The redline speaks for itself when there is one; the caption exists only
    // for the case where there is nothing on screen to explain the outcome.
    const el = render(
      createElement(InlineDiff, {
        segments: computeTextDiff("Cut latency 40%.", "Cut latency."),
        noChangeLabel: "No changes applied — your original bullets.",
      }),
    );
    expect(el.textContent).not.toContain("No changes applied");
  });

  it("renders an unchanged diff exactly as before when no label is passed", () => {
    const el = render(
      createElement(InlineDiff, {
        segments: computeTextDiff("Cut latency 40%.", "Cut latency 40%."),
      }),
    );
    expect(el.querySelector("div")).toBeNull();
    expect(el.textContent).toBe("Cut latency 40%.");
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelLoadProgress } from "./ModelLoadProgress.tsx";

function render(props: Parameters<typeof ModelLoadProgress>[0]): string {
  return renderToStaticMarkup(createElement(ModelLoadProgress, props));
}

describe("ModelLoadProgress", () => {
  it("renders the caller-supplied label and percentage", () => {
    const html = render({ progress: 0.42, label: "Loading Foo Model" });
    expect(html).toContain("Loading Foo Model");
    expect(html).toContain("42%");
  });

  it("clamps progress to 0..100 — under-range and over-range fractions stay in bounds", () => {
    expect(render({ progress: -0.5, label: "x" })).toContain('aria-valuenow="0"');
    expect(render({ progress: 1.5, label: "x" })).toContain(
      'aria-valuenow="100"',
    );
  });

  it("rounds the displayed percentage so the screen-reader text matches the bar", () => {
    const html = render({ progress: 0.6789, label: "x" });
    expect(html).toContain("68%");
    expect(html).toContain('aria-valuenow="68"');
  });

  it("renders the optional status text only when provided", () => {
    expect(render({ progress: 0.5, label: "x" })).not.toContain("fetching");
    expect(
      render({ progress: 0.5, label: "x", text: "fetching weights" }),
    ).toContain("fetching weights");
  });

  it("renders the 'What's happening?' disclosure only when showExplainer is true", () => {
    // `renderToStaticMarkup` HTML-encodes the apostrophe; match the prefix
    // that survives encoding so the test stays robust either way.
    expect(render({ progress: 0.5, label: "x" })).not.toMatch(/What.{1,6}s happening/);
    expect(render({ progress: 0.5, label: "x", showExplainer: true })).toMatch(
      /What.{1,6}s happening/,
    );
  });

  it("uses role=progressbar with the documented aria-value{min,max} bounds", () => {
    const html = render({ progress: 0.3, label: "x" });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="30"');
  });
});

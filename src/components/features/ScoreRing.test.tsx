// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ScoreRing's `size` prop (#953).
 *
 * `size` drives the svg box AND the geometry derived from it — radius,
 * circumference, dash offset — so a caller passing a non-default size is
 * trusting arithmetic no other test covered. The default is pinned separately
 * because `AtsScoreReadout` is the only caller that passes a size, and every
 * other consumer silently depends on 96 staying 96.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreRing } from "./ScoreRing.tsx";

function widthOf(html: string): string | undefined {
  return /width="(\d+)"/.exec(html)?.[1];
}

describe("ScoreRing", () => {
  it("defaults to a 96px box", () => {
    const html = renderToStaticMarkup(<ScoreRing score={72} />);
    expect(widthOf(html)).toBe("96");
    expect(html).toContain('viewBox="0 0 96 96"');
  });

  it("honours an explicit size", () => {
    const html = renderToStaticMarkup(<ScoreRing score={72} size={84} />);
    expect(widthOf(html)).toBe("84");
    expect(html).toContain('viewBox="0 0 84 84"');
  });

  it("scales the arc geometry with the size", () => {
    // radius = (size - strokeWidth) / 2, so the dasharray must differ between
    // two sizes; a hardcoded circumference would render the same arc for both.
    const small = renderToStaticMarkup(<ScoreRing score={50} size={84} />);
    const large = renderToStaticMarkup(<ScoreRing score={50} size={96} />);
    const dash = (html: string) => /stroke-dasharray="([\d.]+)"/.exec(html)?.[1];
    expect(dash(small)).toBeDefined();
    expect(dash(small)).not.toBe(dash(large));
  });

  it("clamps the arc for an out-of-range score", () => {
    const over = renderToStaticMarkup(<ScoreRing score={140} />);
    // Fully complete arc — no negative dash offset.
    expect(over).toContain('stroke-dashoffset="0"');
  });

  it("renders the score and its max", () => {
    const html = renderToStaticMarkup(<ScoreRing score={72} />);
    expect(html).toContain("72");
    expect(html).toContain("/ 100");
  });
});

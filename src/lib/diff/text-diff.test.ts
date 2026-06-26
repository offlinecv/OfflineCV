// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { computeTextDiff } from "./text-diff.ts";

describe("computeTextDiff", () => {
  it("(a) equal strings → single equal segment", () => {
    const segments = computeTextDiff("hello world", "hello world");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ type: "equal", text: "hello world" });
  });

  it("(b) empty old → single added segment", () => {
    const segments = computeTextDiff("", "new text");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ type: "added", text: "new text" });
  });

  it("(c) empty new → single removed segment", () => {
    const segments = computeTextDiff("old text", "");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ type: "removed", text: "old text" });
  });

  it("(d) mixed — reconstructs both texts from non-removed/non-added segments", () => {
    const oldText = "Led a team of 3 engineers";
    const newText = "Managed a team of 5 engineers and shipped 2 features";

    const segments = computeTextDiff(oldText, newText);

    // At least one added and one removed segment must be present
    expect(segments.some((s) => s.type === "added")).toBe(true);
    expect(segments.some((s) => s.type === "removed")).toBe(true);

    // Non-removed segments reconstruct newText
    const reconstructedNew = segments
      .filter((s) => s.type !== "removed")
      .map((s) => s.text)
      .join("");
    expect(reconstructedNew).toBe(newText);

    // Non-added segments reconstruct oldText
    const reconstructedOld = segments
      .filter((s) => s.type !== "added")
      .map((s) => s.text)
      .join("");
    expect(reconstructedOld).toBe(oldText);
  });
});

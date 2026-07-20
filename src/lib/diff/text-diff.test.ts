// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { computeTextDiff, computeWordDiff } from "./text-diff.ts";

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

describe("computeWordDiff", () => {
  it("snaps changes to whole-word boundaries (no char-level mash-up)", () => {
    // The bug it fixes: char diff turns "Support"→"Led" into "SupportLed".
    const segments = computeWordDiff(
      "Support departmental assignments",
      "Led departmental assignments",
    );
    // The first word is a clean whole-word remove + add; the shared tail stays
    // a single equal segment — no segment splits inside a word.
    expect(segments).toContainEqual({ type: "removed", text: "Support" });
    expect(segments).toContainEqual({ type: "added", text: "Led" });
    expect(
      segments.some(
        (s) => s.type === "equal" && s.text.includes(" departmental assignments"),
      ),
    ).toBe(true);
    // No segment is a partial word fragment like "Suppor" / "Led".
    expect(segments.some((s) => s.text === "Suppor" || s.text === "t")).toBe(
      false,
    );
  });

  it("round-trips both sides exactly (whitespace preserved)", () => {
    const oldText = "Led a team of 3 engineers";
    const newText = "Managed a team of 5 engineers and shipped 2 features";
    const segments = computeWordDiff(oldText, newText);
    expect(
      segments
        .filter((s) => s.type !== "removed")
        .map((s) => s.text)
        .join(""),
    ).toBe(newText);
    expect(
      segments
        .filter((s) => s.type !== "added")
        .map((s) => s.text)
        .join(""),
    ).toBe(oldText);
  });

  it("handles the degenerate edges like computeTextDiff", () => {
    expect(computeWordDiff("same", "same")).toEqual([
      { type: "equal", text: "same" },
    ]);
    expect(computeWordDiff("", "x")).toEqual([{ type: "added", text: "x" }]);
    expect(computeWordDiff("x", "")).toEqual([{ type: "removed", text: "x" }]);
  });
});

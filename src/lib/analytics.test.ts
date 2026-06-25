// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { buildFeedbackProps } from "./analytics.ts";

describe("buildFeedbackProps — feedback_submitted payload shaping (#51)", () => {
  it("always includes the rating", () => {
    expect(buildFeedbackProps({ rating: 4 })).toEqual({ rating: 4 });
  });

  it("omits email entirely when not provided (PII contract)", () => {
    const props = buildFeedbackProps({ rating: 5 });
    expect("email" in props).toBe(false);
  });

  it("omits email when it is blank or whitespace — never an empty string", () => {
    expect("email" in buildFeedbackProps({ rating: 5, email: "" })).toBe(false);
    expect("email" in buildFeedbackProps({ rating: 5, email: "   " })).toBe(
      false,
    );
  });

  it("attaches a trimmed email only when the user typed one", () => {
    expect(
      buildFeedbackProps({ rating: 3, email: "  me@example.com " }).email,
    ).toBe("me@example.com");
  });

  it("includes category and trimmed feedback_text only when present", () => {
    expect(
      buildFeedbackProps({
        rating: 2,
        category: "Parsing",
        feedbackText: "  two columns broke  ",
      }),
    ).toEqual({
      rating: 2,
      category: "Parsing",
      feedback_text: "two columns broke",
    });
  });

  it("drops blank category and whitespace-only feedback_text", () => {
    const props = buildFeedbackProps({
      rating: 1,
      category: "",
      feedbackText: "   ",
    });
    expect(props).toEqual({ rating: 1 });
  });
});

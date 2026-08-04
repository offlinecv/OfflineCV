// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  buildFeedbackProps,
  buildCascadeParseCompletedEvent,
  buildLlmParseRanEvent,
  buildLlmFallbackRanEvent,
} from "./analytics.ts";
import { CASCADE_VERSION } from "./heuristics/types.ts";
import type { ParseEvent } from "./heuristics/types.ts";

const completedEvent: Extract<ParseEvent, { type: "parse_completed" }> = {
  type: "parse_completed",
  cascade_version: CASCADE_VERSION,
  user_type: "anon",
  final_source: "tier_1_alone",
  total_duration_ms: 412,
  confidence: 0.82,
  triggers: [],
  tier_mask: 0b11,
  llm_ran: false,
};

describe("parse-event names — one emit per parse (#734)", () => {
  it("gives the cascade completion and the two LLM passes distinct names", () => {
    const names = [
      buildCascadeParseCompletedEvent(completedEvent).event,
      buildLlmParseRanEvent({ model: "Llama-3.2-3B" }).event,
      buildLlmFallbackRanEvent({ model: "Llama-3.2-3B" }).event,
    ];
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual([
      "cascade_parse_completed",
      "llm_parse_ran",
      "llm_fallback_ran",
    ]);
  });

  it("emits cascade_parse_completed from the cascade path only", () => {
    // The regression: both LLM passes used to re-emit this name, so counting it
    // counted LLM passes too and parse success rate read above 100%.
    expect(buildLlmParseRanEvent({ model: "m" }).event).not.toBe(
      "cascade_parse_completed",
    );
    expect(buildLlmFallbackRanEvent({ model: "m" }).event).not.toBe(
      "cascade_parse_completed",
    );
  });

  it("carries total_duration_ms on the cascade emit and on neither LLM emit", () => {
    // Saved insights filter on `total_duration_ms is set` to exclude the
    // historical re-emits. That filter stays correct only while this holds.
    expect(buildCascadeParseCompletedEvent(completedEvent).props).toHaveProperty(
      "total_duration_ms",
      412,
    );
    expect(buildLlmParseRanEvent({ model: "m" }).props).not.toHaveProperty(
      "total_duration_ms",
    );
    expect(buildLlmFallbackRanEvent({ model: "m" }).props).not.toHaveProperty(
      "total_duration_ms",
    );
  });

  it("keeps llm_ran true on both LLM events and the fallback's final_source", () => {
    expect(buildLlmParseRanEvent({ model: "m" }).props.llm_ran).toBe(true);
    expect(buildLlmFallbackRanEvent({ model: "m" }).props).toMatchObject({
      llm_ran: true,
      final_source: "llm_fallback",
      model: "m",
    });
  });

  it("carries no field values or PII on any of the three", () => {
    const all = [
      buildCascadeParseCompletedEvent(completedEvent).props,
      buildLlmParseRanEvent({ model: "m" }).props,
      buildLlmFallbackRanEvent({ model: "m" }).props,
    ];
    const allowed = new Set([
      "cascade_version",
      "user_type",
      "final_source",
      "total_duration_ms",
      "confidence",
      "triggers",
      "tier_mask",
      "llm_ran",
      "model",
    ]);
    for (const props of all) {
      for (const key of Object.keys(props)) expect(allowed.has(key)).toBe(true);
    }
  });
});

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

  it("flags wants_contact only when the user opted in", () => {
    expect("wants_contact" in buildFeedbackProps({ rating: 4 })).toBe(false);
    expect(
      "wants_contact" in buildFeedbackProps({ rating: 4, wantsContact: false }),
    ).toBe(false);
    expect(
      buildFeedbackProps({ rating: 4, wantsContact: true }).wants_contact,
    ).toBe(true);
  });
});

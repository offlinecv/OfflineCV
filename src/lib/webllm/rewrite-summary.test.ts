// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it, vi } from "vitest";
import {
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
  rewriteSummaryWithLlm,
  SUMMARY_REWRITE_SYSTEM_PROMPT,
} from "./rewrite-summary.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  WebLlmEngine,
} from "./types.ts";

const TEST_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

function makeEngine(
  reply: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>,
): {
  engine: WebLlmEngine;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(reply);
  const engine: WebLlmEngine = { chat: { completions: { create: spy } } };
  return { engine, spy };
}

function reply(content: string | null): ChatCompletionResponse {
  return { choices: [{ message: { content } }] };
}

describe("buildSummaryUserPrompt", () => {
  it("emits a labeled before/after scaffolding for the model", () => {
    expect(buildSummaryUserPrompt("Senior engineer with 10 years.")).toBe(
      "Original summary:\nSenior engineer with 10 years.\n\nRewritten summary:",
    );
  });

  it("does not accept a context parameter — context belongs to buildSummarySystemPrompt", () => {
    // Regression guard: context moved off the user message after the small
    // models echoed the prior-section preview into their output (#67 follow-up).
    expect(buildSummaryUserPrompt("Engineer.")).toBe(
      "Original summary:\nEngineer.\n\nRewritten summary:",
    );
  });
});

describe("buildSummarySystemPrompt", () => {
  it("returns the base rules verbatim when no context is given", () => {
    expect(buildSummarySystemPrompt()).toBe(SUMMARY_REWRITE_SYSTEM_PROMPT);
    expect(buildSummarySystemPrompt(undefined)).toBe(SUMMARY_REWRITE_SYSTEM_PROMPT);
  });

  it("returns the base rules verbatim for a whitespace-only context", () => {
    expect(buildSummarySystemPrompt("   ")).toBe(SUMMARY_REWRITE_SYSTEM_PROMPT);
  });

  it("appends a reference-only context block when context is set", () => {
    const out = buildSummarySystemPrompt(
      "Verbs already used in prior bullets: built, led.",
    );
    expect(out.startsWith(SUMMARY_REWRITE_SYSTEM_PROMPT)).toBe(true);
    expect(out).toContain("reference only");
    expect(out).toContain("Verbs already used in prior bullets: built, led.");
  });
});

describe("rewriteSummaryWithLlm", () => {
  it("sends the summary system prompt and labeled user prompt", async () => {
    const { engine, spy } = makeEngine(async () =>
      reply("Senior engineer with 10 years building distributed systems."),
    );
    await rewriteSummaryWithLlm(
      "I am a senior engineer with 10 years of experience.",
      engine,
      TEST_MODEL,
    );
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    expect(req.messages[0]).toEqual({
      role: "system",
      content: SUMMARY_REWRITE_SYSTEM_PROMPT,
    });
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).toContain("Original summary:");
    expect(req.messages[1]?.content).toContain("Rewritten summary:");
  });

  it("uses the 256-token cap regardless of input length", async () => {
    const { engine, spy } = makeEngine(async () => reply("Engineer."));
    await rewriteSummaryWithLlm("x".repeat(2000), engine, TEST_MODEL);
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    expect(req.max_tokens).toBe(256);
  });

  it("collapses a wrapped paragraph into a single line with single spaces", async () => {
    const { engine } = makeEngine(async () =>
      reply("Senior engineer.\nLed a team of 5.\nShipped 3 products."),
    );
    const out = await rewriteSummaryWithLlm("Engineer.", engine, TEST_MODEL);
    expect(out.text).toBe("Senior engineer. Led a team of 5. Shipped 3 products.");
  });

  it("strips a Rewritten: echo from the model output", async () => {
    const { engine } = makeEngine(async () =>
      reply("Rewritten: Senior engineer with 10 years."),
    );
    const out = await rewriteSummaryWithLlm("Engineer.", engine, TEST_MODEL);
    expect(out.text).toBe("Senior engineer with 10 years.");
  });

  it("reports numbersPreserved=true when every numeric token survives", async () => {
    const { engine } = makeEngine(async () =>
      reply("Senior engineer with 10 years of experience and $1.2M in ARR."),
    );
    const out = await rewriteSummaryWithLlm(
      "I have 10 years and drove $1.2M in ARR.",
      engine,
      TEST_MODEL,
    );
    expect(out.numbersPreserved).toBe(true);
  });

  it("flags numbersPreserved=false when a metric is dropped", async () => {
    const { engine } = makeEngine(async () =>
      reply("Senior engineer with a decade of experience."),
    );
    const out = await rewriteSummaryWithLlm(
      "I drove $5K in revenue per quarter.",
      engine,
      TEST_MODEL,
    );
    expect(out.numbersPreserved).toBe(false);
    expect(out.droppedNumbers).toEqual(["$5K"]);
  });

  it("returns an empty text on null model content without throwing", async () => {
    const { engine } = makeEngine(async () => reply(null));
    const out = await rewriteSummaryWithLlm("Engineer.", engine, TEST_MODEL);
    expect(out.text).toBe("");
    expect(out.numbersPreserved).toBe(true);
  });

  it("propagates engine errors to the caller", async () => {
    const boom = new Error("OOM");
    const { engine } = makeEngine(async () => {
      throw boom;
    });
    await expect(
      rewriteSummaryWithLlm("Engineer.", engine, TEST_MODEL),
    ).rejects.toBe(boom);
  });

  it("folds a context brief into the SYSTEM message — never the user message — when options.context is passed", async () => {
    const { engine, spy } = makeEngine(async () => reply("Senior engineer."));
    await rewriteSummaryWithLlm("Engineer.", engine, TEST_MODEL, {
      context: "Verbs already used: built, led.",
    });
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    // System message: carries the context block.
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toContain("Verbs already used: built, led.");
    expect(req.messages[0]?.content).toContain("reference only");
    // User message: stays pure input — never carries the context.
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).not.toContain("Verbs already used");
    expect(req.messages[1]?.content?.startsWith("Original summary:")).toBe(true);
  });
});

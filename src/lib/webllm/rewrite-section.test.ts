// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock analytics so we can assert telemetry firing without depending on
// whether VITE_POSTHOG_KEY is set in the test env.
const {
  trackStartedMock,
  trackCompletedMock,
  trackFirstSectionMock,
  trackFirstRewriteMock,
} = vi.hoisted(() => ({
  trackStartedMock: vi.fn(),
  trackCompletedMock: vi.fn(),
  trackFirstSectionMock: vi.fn(),
  trackFirstRewriteMock: vi.fn(),
}));
vi.mock("../analytics.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics.ts")>();
  return {
    ...actual,
    trackWebllmSectionRewriteStarted: trackStartedMock,
    trackWebllmSectionRewriteCompleted: trackCompletedMock,
    trackWebllmFirstSectionRewrite: trackFirstSectionMock,
    trackWebllmFirstRewrite: trackFirstRewriteMock,
  };
});

import {
  _resetSectionRewriteFlagsForTesting,
  buildSectionSystemPrompt,
  buildSectionUserPrompt,
  rewriteSectionWithLlm,
  sectionMaxTokens,
  SECTION_REWRITE_SYSTEM_PROMPT,
} from "./rewrite-section.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  WebLlmEngine,
} from "./types.ts";

// Pin stable model ids for the section path's telemetry assertions. Using
// string literals (rather than importing DEFAULT_MODEL_ID) keeps this file
// independent of registry shape changes.
const TEST_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const OTHER_MODEL = "gemma-2-2b-it-q4f16_1-MLC";

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

describe("sectionMaxTokens", () => {
  it("floors at 60 for a single bullet", () => {
    expect(sectionMaxTokens(1)).toBe(60);
  });

  it("scales linearly at 60 per bullet", () => {
    expect(sectionMaxTokens(5)).toBe(300);
    expect(sectionMaxTokens(8)).toBe(480);
  });

  it("caps at 768 regardless of bullet count", () => {
    expect(sectionMaxTokens(13)).toBe(768);
    expect(sectionMaxTokens(50)).toBe(768);
  });

  it("does not divide by zero or go negative when called with 0", () => {
    expect(sectionMaxTokens(0)).toBe(60);
  });
});

describe("buildSectionUserPrompt", () => {
  it("numbers the bullets and trims each one", () => {
    expect(
      buildSectionUserPrompt(["  first bullet  ", "second bullet"]),
    ).toBe(
      "Original bullets:\n1. first bullet\n2. second bullet\n\nRewritten bullets:",
    );
  });

  it("does not accept a context parameter — context belongs to the system prompt builder", () => {
    // Regression guard: the chain-of-sections orchestrator (#67) used to
    // thread context through the user prompt, which caused small instruct
    // models to echo the prior-section preview line as a bullet. Context
    // moved to buildSectionSystemPrompt. The user prompt stays pure input.
    const baseline = buildSectionUserPrompt(["first", "second"]);
    expect(baseline).toBe(
      "Original bullets:\n1. first\n2. second\n\nRewritten bullets:",
    );
  });
});

describe("buildSectionSystemPrompt", () => {
  it("returns the base rules verbatim when no context is given", () => {
    expect(buildSectionSystemPrompt()).toBe(SECTION_REWRITE_SYSTEM_PROMPT);
    expect(buildSectionSystemPrompt(undefined)).toBe(
      SECTION_REWRITE_SYSTEM_PROMPT,
    );
  });

  it("returns the base rules verbatim for a whitespace-only context", () => {
    expect(buildSectionSystemPrompt("   ")).toBe(SECTION_REWRITE_SYSTEM_PROMPT);
  });

  it("appends a reference-only context block when context is set", () => {
    const out = buildSectionSystemPrompt(
      "Verbs already used in prior bullets: built, led.",
    );
    expect(out.startsWith(SECTION_REWRITE_SYSTEM_PROMPT)).toBe(true);
    expect(out).toContain("reference only");
    expect(out).toContain("Verbs already used in prior bullets: built, led.");
  });

  it("instructs the model to ignore earlier-section content", () => {
    const out = buildSectionSystemPrompt("any context");
    expect(out).toMatch(/Do not include content from earlier sections/i);
  });
});

describe("rewriteSectionWithLlm", () => {
  beforeEach(() => {
    _resetSectionRewriteFlagsForTesting();
    trackStartedMock.mockClear();
    trackCompletedMock.mockClear();
    trackFirstSectionMock.mockClear();
  });

  it("sends the section system prompt and a numbered user prompt", async () => {
    const { engine, spy } = makeEngine(async () => reply("Shipped X.\nLed Y."));
    await rewriteSectionWithLlm(["worked on X", "managed Y"], engine, TEST_MODEL);
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    expect(req.messages[0]).toEqual({
      role: "system",
      content: SECTION_REWRITE_SYSTEM_PROMPT,
    });
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).toContain("1. worked on X");
    expect(req.messages[1]?.content).toContain("2. managed Y");
  });

  it("uses sectionMaxTokens as max_tokens", async () => {
    const { engine, spy } = makeEngine(async () => reply("A.\nB."));
    await rewriteSectionWithLlm(["x", "y"], engine, TEST_MODEL);
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    expect(req.max_tokens).toBe(sectionMaxTokens(2));
  });

  it("splits on newlines and keeps every non-empty cleaned line (M != N)", async () => {
    const { engine } = makeEngine(async () =>
      reply(
        "Shipped Foo to 10M users.\n" +
          "\n" +
          "Led 5 engineers to cut p99 latency 40%.\n" +
          "Drove $1.2M ARR.\n",
      ),
    );
    // Three input bullets, three output bullets — but the model could
    // legitimately return 2 or 4, and the function must handle it.
    const out = await rewriteSectionWithLlm(
      ["worked on Foo", "led the team", "sold things"],
      engine,
      TEST_MODEL,
    );
    expect(out.bullets).toEqual([
      "Shipped Foo to 10M users.",
      "Led 5 engineers to cut p99 latency 40%.",
      "Drove $1.2M ARR.",
    ]);
  });

  it("strips numbered list markers from each line", async () => {
    const { engine } = makeEngine(async () =>
      reply("1. Shipped Foo.\n2) Led Y.\n3. Drove Z."),
    );
    const out = await rewriteSectionWithLlm(["a", "b", "c"], engine, TEST_MODEL);
    expect(out.bullets).toEqual(["Shipped Foo.", "Led Y.", "Drove Z."]);
  });

  it("strips Rewritten: prefix and surrounding quotes per line", async () => {
    const { engine } = makeEngine(async () =>
      reply('Rewritten: "Shipped Foo."\n"Led Y."'),
    );
    const out = await rewriteSectionWithLlm(["a", "b"], engine, TEST_MODEL);
    expect(out.bullets).toEqual(["Shipped Foo.", "Led Y."]);
  });

  it("reports numbersPreserved=true when every numeric token survives", async () => {
    const { engine } = makeEngine(async () =>
      reply("Cut p99 latency 40% via sharding.\nDrove $1.2M ARR."),
    );
    const out = await rewriteSectionWithLlm(
      ["Cut p99 latency 40% by sharding", "Drove $1.2M in ARR"],
      engine,
      TEST_MODEL,
    );
    expect(out.numbersPreserved).toBe(true);
    expect(out.droppedNumbers).toEqual([]);
    expect(out.addedNumbers).toEqual([]);
  });

  it("flags numbersPreserved=false with the specific dropped token", async () => {
    const { engine } = makeEngine(async () =>
      reply("Saved the team some money each quarter."),
    );
    const out = await rewriteSectionWithLlm(
      ["Saved the team $5K per quarter."],
      engine,
      TEST_MODEL,
    );
    expect(out.numbersPreserved).toBe(false);
    expect(out.droppedNumbers).toEqual(["$5K"]);
  });

  it("flags an invented number in added", async () => {
    const { engine } = makeEngine(async () =>
      reply("Improved availability to 99.9%."),
    );
    const out = await rewriteSectionWithLlm(
      ["Improved availability."],
      engine,
      TEST_MODEL,
    );
    expect(out.numbersPreserved).toBe(false);
    expect(out.addedNumbers).toEqual(["99.9%"]);
  });

  it("fires webllm_section_rewrite_started and _completed with counts and preservation flag", async () => {
    const { engine } = makeEngine(async () =>
      reply("Shipped Foo.\nDrove Z."),
    );
    await rewriteSectionWithLlm(["a", "b", "c"], engine, TEST_MODEL);
    expect(trackStartedMock).toHaveBeenCalledWith({
      model: TEST_MODEL,
      inputBulletCount: 3,
    });
    expect(trackCompletedMock).toHaveBeenCalledWith({
      model: TEST_MODEL,
      inputBulletCount: 3,
      outputBulletCount: 2,
      numbersPreserved: true,
    });
  });

  it("fires webllm_first_section_rewrite exactly once across calls for the same model", async () => {
    const { engine } = makeEngine(async () => reply("Shipped Foo."));
    await rewriteSectionWithLlm(["a"], engine, TEST_MODEL);
    await rewriteSectionWithLlm(["b"], engine, TEST_MODEL);
    expect(trackFirstSectionMock).toHaveBeenCalledTimes(1);
    expect(trackFirstSectionMock).toHaveBeenCalledWith({ model: TEST_MODEL });
  });

  it("fires webllm_first_section_rewrite ONCE PER MODEL — a different model id re-arms the one-shot", async () => {
    const { engine } = makeEngine(async () => reply("Shipped Foo."));
    await rewriteSectionWithLlm(["a"], engine, TEST_MODEL);
    await rewriteSectionWithLlm(["b"], engine, OTHER_MODEL);
    expect(trackFirstSectionMock).toHaveBeenCalledTimes(2);
    expect(trackFirstSectionMock).toHaveBeenNthCalledWith(1, {
      model: TEST_MODEL,
    });
    expect(trackFirstSectionMock).toHaveBeenNthCalledWith(2, {
      model: OTHER_MODEL,
    });
  });

  it("does not fire webllm_first_section_rewrite when output is empty", async () => {
    const { engine } = makeEngine(async () => reply(null));
    await rewriteSectionWithLlm(["a"], engine, TEST_MODEL);
    expect(trackFirstSectionMock).not.toHaveBeenCalled();
  });

  it("does NOT fire the per-bullet webllm_first_rewrite key", async () => {
    const { engine } = makeEngine(async () => reply("Shipped Foo."));
    await rewriteSectionWithLlm(["a"], engine, TEST_MODEL);
    expect(trackFirstRewriteMock).not.toHaveBeenCalled();
  });

  it("returns an empty bullets array on null model content without throwing", async () => {
    const { engine } = makeEngine(async () => reply(null));
    const out = await rewriteSectionWithLlm(["a"], engine, TEST_MODEL);
    expect(out.bullets).toEqual([]);
    expect(out.numbersPreserved).toBe(true);
  });

  it("propagates engine errors to the caller", async () => {
    const boom = new Error("OOM");
    const { engine } = makeEngine(async () => {
      throw boom;
    });
    await expect(rewriteSectionWithLlm(["a"], engine, TEST_MODEL)).rejects.toBe(
      boom,
    );
  });

  it("folds a context brief into the SYSTEM message — never the user message — when options.context is passed", async () => {
    const { engine, spy } = makeEngine(async () => reply("Shipped Foo."));
    await rewriteSectionWithLlm(["a"], engine, TEST_MODEL, {
      context: "Verbs already used in prior bullets: built, led.",
    });
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    // System message: carries the context block.
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toContain(
      "Verbs already used in prior bullets: built, led.",
    );
    expect(req.messages[0]?.content).toContain("reference only");
    // User message: stays pure input — never carries the context.
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).not.toContain("Verbs already used");
    expect(req.messages[1]?.content?.startsWith("Original bullets:")).toBe(true);
  });

  it("uses the base system prompt verbatim when called with no options (regression guard)", async () => {
    const { engine, spy } = makeEngine(async () => reply("Shipped Foo."));
    await rewriteSectionWithLlm(["a"], engine, TEST_MODEL);
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    expect(req.messages[0]?.content).toBe(SECTION_REWRITE_SYSTEM_PROMPT);
    expect(req.messages[1]?.content?.startsWith("Original bullets:")).toBe(true);
  });
});

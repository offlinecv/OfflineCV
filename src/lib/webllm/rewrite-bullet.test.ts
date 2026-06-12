// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the analytics tracker so we can assert the empty-output gating
// without depending on whether VITE_POSTHOG_KEY happens to be set.
// vi.hoisted lets us reference the mock from the hoisted vi.mock factory.
const { trackFirstRewriteMock } = vi.hoisted(() => ({
  trackFirstRewriteMock: vi.fn(),
}));
vi.mock("../analytics.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics.ts")>();
  return { ...actual, trackWebllmFirstRewrite: trackFirstRewriteMock };
});

import {
  _resetRewriteFlagsForTesting,
  BULLET_REWRITE_SYSTEM_PROMPT,
  buildUserPrompt,
  rewriteBulletWithLlm,
} from "./rewrite-bullet.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  WebLlmEngine,
} from "./types.ts";

function makeEngine(
  reply: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>,
): {
  engine: WebLlmEngine;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(reply);
  const engine: WebLlmEngine = {
    chat: { completions: { create: spy } },
  };
  return { engine, spy };
}

function reply(content: string | null): ChatCompletionResponse {
  return { choices: [{ message: { content } }] };
}

describe("rewriteBulletWithLlm", () => {
  beforeEach(() => {
    _resetRewriteFlagsForTesting();
    trackFirstRewriteMock.mockClear();
  });

  it("sends the system prompt and a user message containing the bullet", async () => {
    const { engine, spy } = makeEngine(async () => reply("Shipped Foo to 10M users."));
    const bullet = "  worked on stuff   ";
    await rewriteBulletWithLlm(bullet, engine);

    expect(spy).toHaveBeenCalledTimes(1);
    const req = spy.mock.calls[0]![0] as ChatCompletionRequest;
    expect(req.messages[0]).toEqual({
      role: "system",
      content: BULLET_REWRITE_SYSTEM_PROMPT,
    });
    expect(req.messages[1]?.role).toBe("user");
    // The user message contains the trimmed bullet text exactly once.
    expect(req.messages[1]?.content).toBe(buildUserPrompt(bullet));
    expect(req.messages[1]?.content).toContain("worked on stuff");
    expect(
      (req.messages[1]?.content.match(/worked on stuff/g) ?? []).length,
    ).toBe(1);
  });

  it("returns the model's output trimmed and prefix-stripped", async () => {
    const { engine } = makeEngine(async () =>
      reply("Rewritten: Shipped Foo to 10M users.  "),
    );
    const out = await rewriteBulletWithLlm("orig", engine);
    expect(out).toBe("Shipped Foo to 10M users.");
  });

  it("keeps only the first non-empty line of the model output", async () => {
    const { engine } = makeEngine(async () =>
      reply("\n\nLed migration to Postgres, cutting tail latency 40%.\n\nNote: blah"),
    );
    const out = await rewriteBulletWithLlm("orig", engine);
    expect(out).toBe("Led migration to Postgres, cutting tail latency 40%.");
  });

  it("strips wrapping quotes the model sometimes adds", async () => {
    const { engine } = makeEngine(async () =>
      reply('"Shipped Foo to 10M users."'),
    );
    const out = await rewriteBulletWithLlm("orig", engine);
    expect(out).toBe("Shipped Foo to 10M users.");
  });

  it("returns an empty string when the model returns null content", async () => {
    const { engine } = makeEngine(async () => reply(null));
    const out = await rewriteBulletWithLlm("orig", engine);
    expect(out).toBe("");
  });

  it("does NOT fire webllm_first_rewrite when the output is empty", async () => {
    const { engine } = makeEngine(async () => reply(null));
    await rewriteBulletWithLlm("orig", engine);
    expect(trackFirstRewriteMock).not.toHaveBeenCalled();
  });

  it("fires webllm_first_rewrite exactly once on the first non-empty rewrite", async () => {
    const { engine } = makeEngine(async () => reply("Shipped Foo."));
    await rewriteBulletWithLlm("a", engine);
    await rewriteBulletWithLlm("b", engine);
    expect(trackFirstRewriteMock).toHaveBeenCalledTimes(1);
  });

  it("propagates engine errors to the caller", async () => {
    const boom = new Error("OOM");
    boom.name = "OutOfMemory";
    const { engine } = makeEngine(async () => {
      throw boom;
    });
    await expect(rewriteBulletWithLlm("orig", engine)).rejects.toBe(boom);
  });
});

describe("buildUserPrompt", () => {
  it("trims the bullet and uses the standard prefix/suffix", () => {
    expect(buildUserPrompt("  hello world  ")).toBe(
      "Original: hello world\nRewritten:",
    );
  });
});

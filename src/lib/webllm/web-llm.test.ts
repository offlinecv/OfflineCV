// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateMLCEngine = vi.fn();

// `vi.mock` is hoisted to the top of the file and intercepts both static and
// dynamic `import("@mlc-ai/web-llm")`, so `loadEngine`'s lazy import resolves
// to this stub without pulling the real ~6 MB library into the test env.
vi.mock("@mlc-ai/web-llm", () => ({
  CreateMLCEngine: mockCreateMLCEngine,
}));

import {
  _resetEngineCacheForTesting,
  MODEL_ID,
  loadEngine,
} from "./web-llm.ts";
import type { WebLlmEngine } from "./types.ts";

function fakeEngine(): WebLlmEngine {
  return { chat: { completions: { create: vi.fn() } } };
}

const noop = () => {};

describe("loadEngine", () => {
  beforeEach(() => {
    _resetEngineCacheForTesting();
    mockCreateMLCEngine.mockReset();
  });

  it("passes the pinned MODEL_ID to CreateMLCEngine", async () => {
    const engine = fakeEngine();
    mockCreateMLCEngine.mockResolvedValue(engine);
    await loadEngine(noop);
    expect(mockCreateMLCEngine).toHaveBeenCalledWith(
      MODEL_ID,
      expect.objectContaining({ initProgressCallback: expect.any(Function) }),
    );
  });

  it("caches the engine for the page lifetime — concurrent calls share one load", async () => {
    const engine = fakeEngine();
    mockCreateMLCEngine.mockResolvedValue(engine);
    const [a, b, c] = await Promise.all([
      loadEngine(noop),
      loadEngine(noop),
      loadEngine(noop),
    ]);
    expect(a).toBe(engine);
    expect(b).toBe(engine);
    expect(c).toBe(engine);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("clears the cache on failure so a Try-again retry can recover", async () => {
    // First attempt: the library throws (simulates OOM or a dropped weight
    // fetch). The cached slot must not retain this rejected promise — every
    // subsequent click would otherwise re-reject instantly and the UI's
    // "Try again" button would be a no-op.
    const failure = new Error("OOM");
    mockCreateMLCEngine.mockRejectedValueOnce(failure);
    await expect(loadEngine(noop)).rejects.toBe(failure);

    // Second attempt: must re-invoke CreateMLCEngine and resolve with the new
    // engine. If the cache wasn't cleared, this would short-circuit to the
    // rejected promise from above.
    const engine = fakeEngine();
    mockCreateMLCEngine.mockResolvedValueOnce(engine);
    await expect(loadEngine(noop)).resolves.toBe(engine);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(2);
  });

  it("forwards initProgressCallback reports to the supplied onProgress", async () => {
    let captured: { progress: number; text: string } | null = null;
    mockCreateMLCEngine.mockImplementationOnce(async (_id, opts) => {
      opts.initProgressCallback({ progress: 0.42, text: "fetching weights" });
      return fakeEngine();
    });
    await loadEngine((u) => {
      captured = u;
    });
    expect(captured).toEqual({ progress: 0.42, text: "fetching weights" });
  });
});

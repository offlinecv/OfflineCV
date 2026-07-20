// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateMLCEngine = vi.fn();

// `vi.mock` is hoisted to the top of the file and intercepts both static and
// dynamic `import("@mlc-ai/web-llm")`, so `loadEngine`'s lazy import resolves
// to this stub without pulling the real ~6 MB library into the test env.
vi.mock("@mlc-ai/web-llm", () => ({
  CreateMLCEngine: mockCreateMLCEngine,
}));

const { trackDownloadStartedMock, trackLoadedMock } = vi.hoisted(() => ({
  trackDownloadStartedMock: vi.fn(),
  trackLoadedMock: vi.fn(),
}));
vi.mock("../analytics.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics.ts")>();
  return {
    ...actual,
    trackWebllmDownloadStarted: trackDownloadStartedMock,
    trackWebllmLoaded: trackLoadedMock,
  };
});

import {
  _resetEngineCacheForTesting,
  acquireInference,
  loadEngine,
  releaseInference,
} from "./web-llm.ts";
import { DEFAULT_MODEL_ID, MODEL_REGISTRY } from "./models.ts";
import type { WebLlmEngine } from "./types.ts";

interface FakeEngine extends WebLlmEngine {
  unload: ReturnType<typeof vi.fn>;
  __id: string;
}

function fakeEngine(id: string): FakeEngine {
  return {
    __id: id,
    chat: { completions: { create: vi.fn() } },
    unload: vi.fn(async () => {}),
  };
}

const noop = () => {};

// Two known-good registry entries we can switch between.
const MODEL_A = DEFAULT_MODEL_ID; // Apache-2.0
const MODEL_B = MODEL_REGISTRY.find(
  (m) => m.licenseType === "Restricted-Community",
)!.id;

describe("loadEngine", () => {
  beforeEach(() => {
    _resetEngineCacheForTesting();
    mockCreateMLCEngine.mockReset();
    trackDownloadStartedMock.mockClear();
    trackLoadedMock.mockClear();
  });

  it("passes the requested model id to CreateMLCEngine", async () => {
    const engine = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValue(engine);
    await loadEngine(MODEL_A, noop);
    expect(mockCreateMLCEngine).toHaveBeenCalledWith(
      MODEL_A,
      expect.objectContaining({ initProgressCallback: expect.any(Function) }),
    );
  });

  it("caches per model — concurrent calls with the same id share one load", async () => {
    const engine = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValue(engine);
    const [a, b, c] = await Promise.all([
      loadEngine(MODEL_A, noop),
      loadEngine(MODEL_A, noop),
      loadEngine(MODEL_A, noop),
    ]);
    expect(a).toBe(engine);
    expect(b).toBe(engine);
    expect(c).toBe(engine);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("returns the cached engine on a repeat call for the same id", async () => {
    const engine = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValue(engine);
    const first = await loadEngine(MODEL_A, noop);
    const second = await loadEngine(MODEL_A, noop);
    expect(second).toBe(first);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("evicts the prior model AND calls its `unload()` when a different model is loaded", async () => {
    const engineA = fakeEngine(MODEL_A);
    const engineB = fakeEngine(MODEL_B);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);

    const a = await loadEngine(MODEL_A, noop);
    expect(a).toBe(engineA);
    expect(engineA.unload).not.toHaveBeenCalled();

    const b = await loadEngine(MODEL_B, noop);
    expect(b).toBe(engineB);
    // Wait a tick so the fire-and-forget unload promise gets to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(engineA.unload).toHaveBeenCalledTimes(1);
    expect(engineB.unload).not.toHaveBeenCalled();
  });

  it("after switching to model B, asking for model A again starts a fresh load", async () => {
    const engineA1 = fakeEngine(MODEL_A);
    const engineB = fakeEngine(MODEL_B);
    const engineA2 = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA1);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA2);

    await loadEngine(MODEL_A, noop);
    await loadEngine(MODEL_B, noop);
    const aAgain = await loadEngine(MODEL_A, noop);

    expect(aAgain).toBe(engineA2);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(3);
  });

  it("a failed switch clears only the failing model's slot (the prior model was already evicted)", async () => {
    // Sequence: B loads OK → switch to A. The switch evicts B BEFORE A
    // starts loading (memory invariant), so when A fails the user is left
    // with no resident engine — that's a deliberate trade-off the file
    // docstring spells out. This test pins both halves of the behavior:
    //   (1) B's `.unload()` was called as part of the eviction;
    //   (2) A's slot is cleared on failure, so a retry of A re-invokes.
    const engineB = fakeEngine(MODEL_B);
    const engineA = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);
    await loadEngine(MODEL_B, noop);

    const failure = new Error("OOM");
    mockCreateMLCEngine.mockRejectedValueOnce(failure);
    await expect(loadEngine(MODEL_A, noop)).rejects.toBe(failure);

    // Drain the fire-and-forget unload promises so the assertion below sees
    // them. Two ticks: one for the eviction's `.then` and one for the
    // chained `.catch` we added to silence unload rejections.
    await Promise.resolve();
    await Promise.resolve();
    expect(engineB.unload).toHaveBeenCalledTimes(1);

    // A retry of A must re-invoke CreateMLCEngine (its slot was cleared on
    // failure). B is NOT re-loadable from cache — it's gone.
    mockCreateMLCEngine.mockResolvedValueOnce(engineA);
    await expect(loadEngine(MODEL_A, noop)).resolves.toBe(engineA);
    // Total: B (1) + failed A (2) + successful A (3) = 3 invocations.
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(3);
  });

  it("cross-model concurrent loadEngine calls are serialized through the chain (PR A's TODO, picked up in PR B)", async () => {
    // Two `loadEngine` calls for DIFFERENT model ids issued in the same
    // microtask. With the PR B serialization in place, they execute
    // sequentially through `serialChain` — A starts first (since A's
    // chain entry was created first), then B starts AFTER A's load
    // completes. The observable proof is that `CreateMLCEngine` is
    // called in the order A then B, with `mockResolvedValueOnce`'s queue
    // matching that order; if the chain were broken, the queue would
    // dispatch racy and one of the two would get the wrong engine.
    const engineA = fakeEngine(MODEL_A);
    const engineB = fakeEngine(MODEL_B);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);

    const [a, b] = await Promise.all([
      loadEngine(MODEL_A, noop),
      loadEngine(MODEL_B, noop),
    ]);

    expect(a).toBe(engineA);
    expect(b).toBe(engineB);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(2);
    // Sequencing: A came first, then B. The first call's modelId arg is
    // MODEL_A, the second's is MODEL_B.
    expect(mockCreateMLCEngine.mock.calls[0]![0]).toBe(MODEL_A);
    expect(mockCreateMLCEngine.mock.calls[1]![0]).toBe(MODEL_B);
  });

  it("forwards initProgressCallback reports to the supplied onProgress", async () => {
    let captured: { progress: number; text: string } | null = null;
    mockCreateMLCEngine.mockImplementationOnce(async (_id, opts) => {
      opts.initProgressCallback({ progress: 0.42, text: "fetching weights" });
      return fakeEngine(MODEL_A);
    });
    await loadEngine(MODEL_A, (u) => {
      captured = u;
    });
    expect(captured).toEqual({ progress: 0.42, text: "fetching weights" });
  });

  // ── Per-model telemetry (#64 AC) ─────────────────────────────────────────

  it("fires `webllm_download_started({ model })` once per model id, never twice", async () => {
    mockCreateMLCEngine.mockResolvedValue(fakeEngine(MODEL_A));
    await loadEngine(MODEL_A, noop);
    await loadEngine(MODEL_A, noop);
    expect(trackDownloadStartedMock).toHaveBeenCalledTimes(1);
    expect(trackDownloadStartedMock).toHaveBeenCalledWith({ model: MODEL_A });
  });

  it("fires `webllm_download_started` once for EACH distinct model id", async () => {
    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_A));
    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_B));
    await loadEngine(MODEL_A, noop);
    await loadEngine(MODEL_B, noop);
    expect(trackDownloadStartedMock).toHaveBeenCalledTimes(2);
    expect(trackDownloadStartedMock).toHaveBeenNthCalledWith(1, {
      model: MODEL_A,
    });
    expect(trackDownloadStartedMock).toHaveBeenNthCalledWith(2, {
      model: MODEL_B,
    });
  });

  it("does NOT re-fire `webllm_download_started` for a model whose first load failed (retry case)", async () => {
    // Mirrors the rule from #63's web-llm.ts: a retry of the same model is
    // still the same logical attempt, so the funnel shouldn't double-count.
    mockCreateMLCEngine.mockRejectedValueOnce(new Error("OOM"));
    await expect(loadEngine(MODEL_A, noop)).rejects.toThrow();

    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_A));
    await loadEngine(MODEL_A, noop);

    expect(trackDownloadStartedMock).toHaveBeenCalledTimes(1);
  });

  it("fires `webllm_loaded({ model })` once per model id", async () => {
    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_A));
    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_B));
    await loadEngine(MODEL_A, noop);
    await loadEngine(MODEL_B, noop);
    expect(trackLoadedMock).toHaveBeenCalledTimes(2);
    expect(trackLoadedMock).toHaveBeenNthCalledWith(1, { model: MODEL_A });
    expect(trackLoadedMock).toHaveBeenNthCalledWith(2, { model: MODEL_B });
  });
});

// ── #148 — acquire-before-load TOCTOU regression ────────────────────────────
//
// Background. `loadEngine` + `acquireInference` had a time-of-check-to-
// time-of-use gap. When a rewrite caller hit `loadEngine`'s fast path for an
// already-loaded engine A, the returned promise resolved synchronously, but
// the `await` yielded to the microtask queue before `acquireInference(A)`
// could run (acquire happened INSIDE the rewrite primitive, not before
// loadEngine). In that gap, a concurrent picker switch to B could run its
// chain entry → `evictAllExcept(B)` → see `inflightInferenceCount[A] === 0`
// → call `A.unload()` immediately. The rewrite caller's continuation then
// tried to use a torn-down engine.
//
// Fix. Consumers acquireInference(modelId) BEFORE awaiting loadEngine, paired
// with releaseInference in finally. Then evictAllExcept sees the positive
// count and parks A in `pendingUnload`; the deferred `.unload()` runs the
// moment the caller releases. The pair below pins both halves: the negative
// shape (without the contract, the race is real) and the positive shape
// (with the contract, the engine survives until release).
describe("acquire-before-load TOCTOU (#148)", () => {
  beforeEach(() => {
    _resetEngineCacheForTesting();
    mockCreateMLCEngine.mockReset();
  });

  it("WITHOUT acquireInference before loadEngine: a concurrent eviction unloads the engine — this is the #148 race", async () => {
    // Pre-load A so `loadEngine(A)` hits the fast path.
    const engineA = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA);
    await loadEngine(MODEL_A, noop);

    // Queue a concurrent switch to B. Its chain entry runs eviction inside
    // a microtask — exactly the window the bug exploits.
    const engineB = fakeEngine(MODEL_B);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);
    const bLoadPromise = loadEngine(MODEL_B, noop);

    // Simulate the buggy consumer pattern: await loadEngine, then acquire.
    const engine = await loadEngine(MODEL_A, noop);
    expect(engine).toBe(engineA);

    // Drain microtasks so the B chain entry's eviction runs.
    await bLoadPromise;

    // Without the fix, A.unload was called between the await resolving and
    // the (would-be later) acquireInference call. Count was 0 at eviction
    // time, so eviction proceeded to unload immediately rather than parking.
    expect(engineA.unload).toHaveBeenCalledTimes(1);
  });

  it("WITH acquireInference before loadEngine: eviction parks the engine and defers .unload() until releaseInference", async () => {
    // Pre-load A.
    const engineA = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA);
    await loadEngine(MODEL_A, noop);

    // The CORRECT consumer pattern — acquire SYNCHRONOUSLY, before any await
    // that could yield to a queued chain entry. The acquire pairs with a
    // release in `finally` (here split out at the bottom for clarity).
    acquireInference(MODEL_A);

    // Queue the concurrent switch to B — same shape as the negative test.
    const engineB = fakeEngine(MODEL_B);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);
    const bLoadPromise = loadEngine(MODEL_B, noop);

    // Await the fast-path resolve. The microtask gap is open — but the
    // count is already 1, so the chain entry's eviction parks A.
    const engine = await loadEngine(MODEL_A, noop);
    expect(engine).toBe(engineA);

    // Drain microtasks so the B chain entry's eviction runs.
    await bLoadPromise;

    // A is parked in pendingUnload — NOT unloaded yet.
    expect(engineA.unload).not.toHaveBeenCalled();

    // The engine handle remains usable for inference here (in production
    // this is where rewriteSectionWithLlm / rewriteSummaryWithLlm would
    // call engine.chat.completions.create()).
    expect(engine).toBe(engineA);

    // Release. Count drops to 0 → pending unload drains.
    releaseInference(MODEL_A);
    await Promise.resolve();
    await Promise.resolve();
    expect(engineA.unload).toHaveBeenCalledTimes(1);
  });

  it("WITH acquireInference before loadEngine: nested acquire from a rewrite primitive does not change the deferral semantics (count rises to 2, both releases drain to 0)", async () => {
    // Belt-and-suspenders: the rewrite primitives still call acquire/release
    // INTERNALLY. With the outer pair from the fix, count goes 1 → 2 → 1 → 0.
    // The unload must still defer to the final release.
    const engineA = fakeEngine(MODEL_A);
    mockCreateMLCEngine.mockResolvedValueOnce(engineA);
    await loadEngine(MODEL_A, noop);

    // Outer pair — added by the #148 fix at consumer call sites.
    acquireInference(MODEL_A);

    const engineB = fakeEngine(MODEL_B);
    mockCreateMLCEngine.mockResolvedValueOnce(engineB);
    const bLoadPromise = loadEngine(MODEL_B, noop);
    await loadEngine(MODEL_A, noop);
    await bLoadPromise;
    expect(engineA.unload).not.toHaveBeenCalled();

    // Inner pair — mirrors what rewriteSectionWithLlm / rewriteSummaryWithLlm
    // do today around the model call. Count rises to 2.
    acquireInference(MODEL_A);
    // Inner release — back to 1. Still parked, not drained.
    releaseInference(MODEL_A);
    await Promise.resolve();
    await Promise.resolve();
    expect(engineA.unload).not.toHaveBeenCalled();

    // Outer release — back to 0. Park drains.
    releaseInference(MODEL_A);
    await Promise.resolve();
    await Promise.resolve();
    expect(engineA.unload).toHaveBeenCalledTimes(1);
  });
});

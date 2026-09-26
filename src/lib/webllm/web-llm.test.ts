// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateMLCEngine = vi.fn();

// `vi.mock` is hoisted to the top of the file and intercepts both static and
// dynamic `import("@mlc-ai/web-llm")`, so `loadEngine`'s lazy import resolves
// to this stub without pulling the real ~6 MB library into the test env.
vi.mock("@mlc-ai/web-llm", () => ({
  CreateMLCEngine: mockCreateMLCEngine,
  deleteModelAllInfoInCache: vi.fn(async () => {}),
}));

// The weights-on-device probe (#1015) reads Cache Storage, which Node lacks;
// each test states what the cache holds.
const { hasCachedMock } = vi.hoisted(() => ({ hasCachedMock: vi.fn() }));
vi.mock("./model-cache.ts", () => ({ hasModelWeightsCached: hasCachedMock }));

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
  clearModel,
  loadEngine,
  releaseInference,
} from "./web-llm.ts";
import { getEngineStatus, subscribeEngineStatus } from "./engine-status.ts";
import { SHIPPED_MODEL } from "./models.ts";
import {
  _resetModelConsentForTesting,
  ModelConsentRequiredError,
  recordModelConsent,
} from "./consent.ts";
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

/**
 * Wait until `loadEngine`'s slow path has actually reached `CreateMLCEngine`.
 * The path chains a `.catch().then()` onto `serialChain` and awaits
 * `hasModelWeightsCached` plus the dynamic `import("@mlc-ai/web-llm")` first,
 * both real async hops (not a fixed number of microtask ticks), so a test
 * that wants to drive `initProgressCallback` mid-load has to poll rather
 * than guess a tick count.
 */
async function waitForCreateMLCEngineCall(afterCalls: number): Promise<void> {
  await vi.waitFor(() => {
    if (mockCreateMLCEngine.mock.calls.length <= afterCalls) {
      throw new Error("CreateMLCEngine not called yet");
    }
  });
}

type InitProgressCallback = (r: { progress: number; text: string }) => void;

/**
 * Queue one `CreateMLCEngine` call that hangs until `resolveCreate` is
 * invoked, capturing the `initProgressCallback` it was given so a test can
 * drive progress updates mid-load.
 */
function interceptCreateMLCEngine(): {
  resolveCreate: (engine: FakeEngine) => void;
  getInitProgressCallback: () => InitProgressCallback;
} {
  let resolveCreate!: (engine: FakeEngine) => void;
  let capturedCallback: InitProgressCallback | null = null;
  mockCreateMLCEngine.mockImplementationOnce(
    (_id: string, opts: { initProgressCallback: InitProgressCallback }) => {
      capturedCallback = opts.initProgressCallback;
      return new Promise((res) => {
        resolveCreate = res;
      });
    },
  );
  return {
    resolveCreate: (engine) => resolveCreate(engine),
    getInitProgressCallback: () => capturedCallback!,
  };
}

// The shipped model, and a second id to exercise the cross-model machinery
// the eval harnesses still rely on.
const MODEL_A = SHIPPED_MODEL.id;
const MODEL_B = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

// Every test below loads with consent recorded; the consent gate has its own
// describe block that clears it.
beforeEach(() => {
  hasCachedMock.mockReset();
  hasCachedMock.mockResolvedValue(false);
  _resetModelConsentForTesting();
  recordModelConsent(MODEL_A);
  recordModelConsent(MODEL_B);
});

describe("loadEngine — consent gate (#1015)", () => {
  beforeEach(() => {
    _resetEngineCacheForTesting();
    mockCreateMLCEngine.mockReset();
    trackDownloadStartedMock.mockClear();
    _resetModelConsentForTesting();
    localStorage.clear();
  });

  it("rejects without recorded consent and never reaches CreateMLCEngine or telemetry", async () => {
    await expect(loadEngine(MODEL_A, noop)).rejects.toBeInstanceOf(
      ModelConsentRequiredError,
    );
    expect(mockCreateMLCEngine).not.toHaveBeenCalled();
    expect(trackDownloadStartedMock).not.toHaveBeenCalled();
  });

  it("does not count an old license-type consent key as consent for the model", async () => {
    localStorage.setItem("offlinecv:webllm:consent:Restricted-Community", "accepted");
    localStorage.setItem("offlinecv:webllm:consent:Apache-2.0", "accepted");
    await expect(loadEngine(MODEL_A, noop)).rejects.toBeInstanceOf(
      ModelConsentRequiredError,
    );
    expect(mockCreateMLCEngine).not.toHaveBeenCalled();
  });

  it("consent is per model id: accepting one model does not unlock another", async () => {
    recordModelConsent(MODEL_B);
    await expect(loadEngine(MODEL_A, noop)).rejects.toBeInstanceOf(
      ModelConsentRequiredError,
    );
    expect(mockCreateMLCEngine).not.toHaveBeenCalled();
  });

  it("loads once consent for that id is recorded", async () => {
    recordModelConsent(MODEL_A);
    mockCreateMLCEngine.mockResolvedValue(fakeEngine(MODEL_A));
    await loadEngine(MODEL_A, noop);
    expect(mockCreateMLCEngine).toHaveBeenCalledOnce();
  });
});

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

  // ── Fan-out to every concurrent subscriber (#804) ────────────────────────

  it("fans progress out to every concurrent caller sharing one load, not just the first", async () => {
    const { resolveCreate, getInitProgressCallback } = interceptCreateMLCEngine();

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const loadA = loadEngine(MODEL_A, (u) => seenA.push(u));
    // Second caller arrives while the first load is still in flight — the
    // bug this closes: only the first caller's onProgress ever fired.
    const loadB = loadEngine(MODEL_A, (u) => seenB.push(u));
    await waitForCreateMLCEngineCall(0);

    getInitProgressCallback()({ progress: 0.5, text: "fetching weights" });

    const engine = fakeEngine(MODEL_A);
    resolveCreate(engine);
    await expect(loadA).resolves.toBe(engine);
    await expect(loadB).resolves.toBe(engine);

    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);
    expect(seenA).toContainEqual({ progress: 0.5, text: "fetching weights", source: "network" });
    expect(seenB).toContainEqual({ progress: 0.5, text: "fetching weights", source: "network" });
  });

  it("replays the last progress update to a caller who joins mid-load", async () => {
    const { resolveCreate, getInitProgressCallback } = interceptCreateMLCEngine();

    const loadA = loadEngine(MODEL_A, noop);
    await waitForCreateMLCEngineCall(0);
    getInitProgressCallback()({ progress: 0.8, text: "almost there" });

    const late: unknown[] = [];
    const loadB = loadEngine(MODEL_A, (u) => late.push(u));

    // Replayed synchronously on join — no further report needed.
    expect(late).toEqual([{ progress: 0.8, text: "almost there", source: "network" }]);

    const engine = fakeEngine(MODEL_A);
    resolveCreate(engine);
    await loadA;
    await loadB;
  });

  it("rejoining with the same stable onProgress reference does not replay the last update twice", async () => {
    const { resolveCreate, getInitProgressCallback } = interceptCreateMLCEngine();

    const seen: unknown[] = [];
    const onProgress = (u: unknown) => seen.push(u);
    const loadA = loadEngine(MODEL_A, onProgress);
    await waitForCreateMLCEngineCall(0);
    getInitProgressCallback()({ progress: 0.8, text: "almost there" });
    const countAfterUpdate = seen.length;

    // Same caller, same memoized callback — already subscribed, so joining
    // again must not replay `lastUpdate` a second time.
    const loadAgain = loadEngine(MODEL_A, onProgress);
    expect(seen).toHaveLength(countAfterUpdate);

    const engine = fakeEngine(MODEL_A);
    resolveCreate(engine);
    await loadA;
    await loadAgain;
  });

  it("a throwing progress subscriber does not fail the load or block other subscribers", async () => {
    mockCreateMLCEngine.mockImplementationOnce(async (_id, opts) => {
      opts.initProgressCallback({ progress: 0.3, text: "loading" });
      return fakeEngine(MODEL_A);
    });

    const goodSeen: unknown[] = [];
    const throwing = loadEngine(MODEL_A, () => {
      throw new Error("boom");
    });
    const good = loadEngine(MODEL_A, (u) => goodSeen.push(u));

    await expect(throwing).resolves.toBeTruthy();
    await expect(good).resolves.toBeTruthy();
    expect(goodSeen).toContainEqual({ progress: 0.3, text: "loading", source: "network" });
  });

  it("subscribers are released when the load settles — a later load for the same id does not notify a stale subscriber", async () => {
    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_A));
    const seen: unknown[] = [];
    await loadEngine(MODEL_A, (u) => seen.push(u));
    const countAfterFirstLoad = seen.length;

    // Clear the resident engine to force a fresh load, then load again with
    // a different callback. The first callback must not be invoked again.
    await clearModel(MODEL_A);
    mockCreateMLCEngine.mockImplementationOnce(async (_id, opts) => {
      opts.initProgressCallback({ progress: 0.1, text: "again" });
      return fakeEngine(MODEL_A);
    });
    await loadEngine(MODEL_A, noop);
    expect(seen.length).toBe(countAfterFirstLoad);
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
    expect(captured).toEqual({
      progress: 0.42,
      text: "fetching weights",
      source: "network",
    });
  });

  it("tags every report with where the weights come from, probed before the load", async () => {
    hasCachedMock.mockResolvedValue(true);
    const seen: unknown[] = [];
    mockCreateMLCEngine.mockImplementationOnce(async (_id, opts) => {
      opts.initProgressCallback({ progress: 0.5, text: "Loading model from cache[1/9]" });
      return fakeEngine(MODEL_A);
    });
    await loadEngine(MODEL_A, (u) => seen.push(u.source));
    expect(hasCachedMock).toHaveBeenCalledWith(MODEL_A);
    expect(seen).toEqual(["device", "device"]);
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
// loadEngine). In that gap, a concurrent load of model B (then: a picker switch) could run its
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
describe("engine status published to engine-status.ts (#1015)", () => {
  beforeEach(() => {
    _resetEngineCacheForTesting();
    mockCreateMLCEngine.mockReset();
  });

  it("reads loading with every progress report, whoever started the load, then loaded", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEngineStatus(() => {
      const status = getEngineStatus(MODEL_A);
      seen.push(status.kind === "loading" ? `loading:${status.progress.text}` : status.kind);
    });
    mockCreateMLCEngine.mockImplementationOnce(async (_id, opts) => {
      opts.initProgressCallback({ progress: 0.5, text: "fetching weights" });
      return fakeEngine(MODEL_A);
    });
    await loadEngine(MODEL_A, noop);
    unsubscribe();
    // "Starting…" twice: once when the load is queued, once more — now
    // carrying the probed `source` — when its turn comes.
    expect(seen).toEqual([
      "loading:Starting…",
      "loading:Starting…",
      "loading:fetching weights",
      "loaded",
    ]);
  });

  it("returns to idle when the load fails", async () => {
    mockCreateMLCEngine.mockRejectedValueOnce(new Error("OOM"));
    await expect(loadEngine(MODEL_A, noop)).rejects.toThrow("OOM");
    expect(getEngineStatus(MODEL_A).kind).toBe("idle");
  });

  it("returns to idle when the model is cleared or evicted", async () => {
    mockCreateMLCEngine.mockResolvedValueOnce(fakeEngine(MODEL_A));
    await loadEngine(MODEL_A, noop);
    await clearModel(MODEL_A);
    expect(getEngineStatus(MODEL_A).kind).toBe("idle");

    mockCreateMLCEngine
      .mockResolvedValueOnce(fakeEngine(MODEL_A))
      .mockResolvedValueOnce(fakeEngine(MODEL_B));
    await loadEngine(MODEL_A, noop);
    await loadEngine(MODEL_B, noop);
    expect(getEngineStatus(MODEL_A).kind).toBe("idle");
    expect(getEngineStatus(MODEL_B).kind).toBe("loaded");
  });

  it("publishes nothing for a load refused for want of consent", async () => {
    _resetModelConsentForTesting();
    localStorage.clear();
    await expect(loadEngine(MODEL_A, noop)).rejects.toBeInstanceOf(ModelConsentRequiredError);
    expect(getEngineStatus(MODEL_A).kind).toBe("idle");
  });
});

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

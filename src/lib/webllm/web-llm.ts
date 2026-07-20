// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { trackWebllmDownloadStarted, trackWebllmLoaded } from "../analytics.ts";
import type { ProgressUpdate, WebLlmEngine } from "./types.ts";

/**
 * Per-model WebLLM engine cache + loader.
 *
 * The picker (PR B of #64) lets the user switch between three models at
 * runtime. Two correctness constraints follow:
 *
 *   1. **At most one engine resident.** Holding 2–3 multi-GB quantized
 *      models in WebGPU memory will OOM consumer hardware. Each cross-model
 *      load EVICTS prior loaded engines and asks the prior engine to
 *      `.unload()` itself before starting the new download. The spec is
 *      explicit: "call teardown/unload/dispose if it exposes one, otherwise
 *      delete the Map entry and let GC reclaim it."
 *   2. **Cross-model loads serialize.** Two `loadEngine` calls for
 *      different model ids issued in the same microtask must NOT both
 *      start downloading concurrently (the spec's "PR B's picker MUST
 *      serialize"). PR A initially documented this as an unfixed race
 *      because PR A's consumers only ever passed `DEFAULT_MODEL_ID`; PR B
 *      introduces the picker, so this file now actually serializes the
 *      cross-model path via a chained promise.
 *
 * Implementation shape:
 *   - `loadedEngines: Map<modelId, engine>` holds engines whose `.reload()`
 *     finished. Only these are candidates for eviction's `.unload()` call.
 *   - `pendingByModelId: Map<modelId, Promise<engine>>` dedupes concurrent
 *     same-id calls — every caller for the same model gets the same
 *     promise.
 *   - `serialChain: Promise<unknown>` is the cross-model rate-limit. Every
 *     NEW load chains onto it; the chain entry's body only starts the
 *     actual download once its turn arrives. Errors in prior entries are
 *     swallowed by a `.catch` on the chain so a failed load doesn't block
 *     subsequent ones.
 *
 * Failure-during-switch is a documented trade-off: if the user is on model
 * A and asks for B, A's `.unload()` is called when B's turn arrives. If B
 * then fails, A is gone — the retry path is "click Y again." Deferring
 * eviction would double peak VRAM and can OOM on a 4 GB GPU, which is the
 * exact failure we're guarding against. PR B's picker surfaces a per-model
 * failure message and lets the user pick again.
 *
 * Telemetry rules (per #64 AC):
 *   - `webllm_download_started({ model })` fires once per model id, ever.
 *     Retries of a previously-failed model do NOT double-fire.
 *   - `webllm_loaded({ model })` fires once per model id, ever.
 *   - The first-success flags (`webllm_first_section_rewrite`,
 *     `webllm_first_resume_rewrite`) live in `rewrite-section.ts` /
 *     `rewrite-resume.ts` respectively.
 */

interface CacheableEngine extends WebLlmEngine {
  /**
   * MLCEngine's resource-release hook. Optional both because tests pass a
   * narrow stub without it AND because the spec for #64 explicitly handles
   * absence ("call teardown/unload/dispose if it exposes one, otherwise
   * delete the Map entry and let GC reclaim it"). `@mlc-ai/web-llm@0.2.84`'s
   * real `MLCEngine` does expose `unload()`.
   */
  unload?: () => Promise<void>;
}

const loadedEngines = new Map<string, CacheableEngine>();
const pendingByModelId = new Map<string, Promise<WebLlmEngine>>();
const downloadStartedFiredFor = new Set<string>();
const loadedFiredFor = new Set<string>();
let serialChain: Promise<unknown> = Promise.resolve();

/**
 * Per-model count of in-flight `engine.chat.completions.create()` calls.
 * `evictAllExcept` consults this before invoking `.unload()` so an engine
 * mid-inference doesn't get torn down underneath its caller — which is
 * reachable in PR B because `SectionRewrite` / `ResumeRewrite` are separate
 * consumers from the picker, not disabled by its loading state. While the
 * picker is downloading model B, a rewrite caller can fast-path to loaded
 * engine A; the picker's chain then arrives at `evictAllExcept(B)` and would
 * call `A.unload()` mid-stream. With this tracker, the unload is deferred
 * into `pendingUnload` until `releaseInference` drains it on completion.
 */
const inflightInferenceCount = new Map<string, number>();
const pendingUnload = new Map<string, CacheableEngine>();

/**
 * Lazily import and construct the WebLLM engine for `modelId`.
 *
 * ## Inference callers MUST acquire BEFORE awaiting (issue #148)
 *
 * The fast path returns `Promise.resolve(engine)`, but `await` still yields
 * to the microtask queue. A concurrent picker switch's chain entry can run
 * `evictAllExcept(otherId)` in that gap, see `inflightInferenceCount[id]`
 * is 0, and call `engine.unload()` immediately — tearing the engine down
 * before the caller's continuation gets to use it.
 *
 * Inference callers therefore MUST wrap the whole load-and-use sequence with
 * `acquireInference(modelId)` / `releaseInference(modelId)`:
 *
 *     acquireInference(modelId);
 *     try {
 *       const engine = await loadEngine(modelId, onProgress);
 *       await rewriteSectionWithLlm(bullets, engine, modelId); // or similar
 *     } finally {
 *       releaseInference(modelId);
 *     }
 *
 * With a positive count, `evictAllExcept` parks the engine in `pendingUnload`
 * and the deferred `.unload()` only runs once the caller releases. The inner
 * `acquireInference` inside the rewrite primitives is defensive belt — it
 * does not close the load→use gap on its own.
 *
 * Non-inference callers (the model picker preloading a model) do NOT need
 * the wrapper — the gap is harmless if no inference is about to run on the
 * returned engine.
 *
 * Fast paths (no chaining):
 *   - Same model already loaded → returns the engine immediately.
 *   - Same model already pending → returns the in-flight promise.
 *
 * New cross-model load:
 *   - Reserves a slot in `pendingByModelId` so concurrent same-id calls
 *     dedup immediately, even before our turn in the chain.
 *   - Chains after the current `serialChain` tail. Our chain entry's body
 *     waits its turn, then evicts loaded engines, fires telemetry, calls
 *     `CreateMLCEngine`, and resolves the slot's promise.
 *
 * On failure (OOM, dropped network, etc.) the failing slot is cleared and
 * the original error rejects to the caller's await. The chain continues —
 * a queued next load proceeds regardless. `downloadStartedFiredFor`
 * deliberately keeps the model's flag set so a retry doesn't double-fire
 * `webllm_download_started` (per #64 AC).
 */
export function loadEngine(
  modelId: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<WebLlmEngine> {
  // Fast path A: this model is already loaded.
  const loaded = loadedEngines.get(modelId);
  if (loaded) return Promise.resolve(loaded);

  // Fast path B: this model is already being loaded (concurrent same-id
  // calls share one load).
  const pending = pendingByModelId.get(modelId);
  if (pending) return pending;

  // Slow path: chain onto the serial tail. The promise we hand back
  // resolves once our chain entry's body actually finishes loading.
  let resolveOut!: (engine: WebLlmEngine) => void;
  let rejectOut!: (err: unknown) => void;
  const slot = new Promise<WebLlmEngine>((res, rej) => {
    resolveOut = res;
    rejectOut = rej;
  });
  pendingByModelId.set(modelId, slot);

  const chainEntry = serialChain
    .catch(() => {
      // Prior load failed. Don't block us — proceed to our turn.
    })
    .then(async () => {
      try {
        // Re-check: an intervening chain entry may have already loaded our
        // model (unlikely with current consumers but cheap to guard).
        const alreadyLoaded = loadedEngines.get(modelId);
        if (alreadyLoaded) {
          resolveOut(alreadyLoaded);
          return;
        }

        // It's our turn — evict any prior loaded engines so peak VRAM
        // stays at one model's footprint.
        evictAllExcept(modelId);

        if (!downloadStartedFiredFor.has(modelId)) {
          downloadStartedFiredFor.add(modelId);
          trackWebllmDownloadStarted({ model: modelId });
        }

        const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
        const engine = (await CreateMLCEngine(modelId, {
          initProgressCallback: (report) => onProgress(report),
        })) as unknown as CacheableEngine;

        if (!loadedFiredFor.has(modelId)) {
          loadedFiredFor.add(modelId);
          trackWebllmLoaded({ model: modelId });
        }

        loadedEngines.set(modelId, engine);
        if (pendingByModelId.get(modelId) === slot) {
          pendingByModelId.delete(modelId);
        }
        resolveOut(engine);
      } catch (err) {
        if (pendingByModelId.get(modelId) === slot) {
          pendingByModelId.delete(modelId);
        }
        rejectOut(err);
      }
    });

  serialChain = chainEntry;
  return slot;
}

/**
 * Drop every loaded engine except `keepId` and ask each to release its
 * WebGPU resources via `.unload()` if it exposes one — JS GC doesn't free
 * WebGPU allocations on its own.
 *
 * Only iterates `loadedEngines` (engines whose load actually finished).
 * In-flight loads are NOT evicted here — they're queued via the chain and
 * will evict themselves when their turn comes.
 *
 * The spec covers both unload paths: "call teardown/unload/dispose if it
 * exposes one, otherwise delete the Map entry and let GC reclaim it." Map
 * deletion is unconditional; `unload()` is best-effort. Errors from
 * `unload()` itself are swallowed so a flaky teardown doesn't surface as
 * an unhandled rejection.
 *
 * In-flight inference: if the engine has callers mid-`chat.completions.create()`
 * (tracked via `inflightInferenceCount`), its `.unload()` is parked in
 * `pendingUnload`. `releaseInference` drains it when the last in-flight call
 * finishes. The engine has already been removed from `loadedEngines`, so any
 * subsequent `loadEngine` for the same id goes through the chain and gets a
 * fresh download — the parked engine handle is solely for the deferred
 * `.unload()` call, not for serving new callers.
 */
function evictAllExcept(keepId: string): void {
  for (const [id, engine] of loadedEngines) {
    if (id === keepId) continue;
    loadedEngines.delete(id);
    if ((inflightInferenceCount.get(id) ?? 0) > 0) {
      // Park the unload — releaseInference will drain it when the last
      // mid-flight inference call finishes.
      pendingUnload.set(id, engine);
      continue;
    }
    engine.unload?.().catch((err: unknown) => {
      // Silently swallow at the promise level so a flaky teardown doesn't
      // surface as an unhandled rejection, but surface a console warning
      // so an OOM-after-switch bug report has something to investigate.
      console.warn(
        `[webllm] unload failed for evicted model ${id}:`,
        err,
      );
    });
  }
}

/**
 * Bracket an `engine.chat.completions.create()` call with `acquire` /
 * `release`. Callers MUST pair: every `acquireInference(id)` must be
 * matched by exactly one `releaseInference(id)`, even on error paths
 * (use `try { … } finally { releaseInference(id); }`). While the count is
 * positive, `evictAllExcept` parks the engine in `pendingUnload` rather
 * than calling `.unload()` — the deferred unload runs the moment the
 * count returns to zero.
 *
 * The model id passed here is the same id the caller used to acquire the
 * engine via `loadEngine`. We don't infer it from the engine handle
 * because `@mlc-ai/web-llm`'s `MLCEngine` doesn't expose its `modelId`.
 */
export function acquireInference(modelId: string): void {
  inflightInferenceCount.set(
    modelId,
    (inflightInferenceCount.get(modelId) ?? 0) + 1,
  );
}

export function releaseInference(modelId: string): void {
  const next = (inflightInferenceCount.get(modelId) ?? 0) - 1;
  if (next <= 0) {
    inflightInferenceCount.delete(modelId);
    const parked = pendingUnload.get(modelId);
    if (parked) {
      pendingUnload.delete(modelId);
      parked.unload?.().catch((err: unknown) => {
        console.warn(
          `[webllm] deferred unload failed for evicted model ${modelId}:`,
          err,
        );
      });
    }
    return;
  }
  inflightInferenceCount.set(modelId, next);
}

/**
 * Tear down a single resident engine: drop it from `loadedEngines` and
 * release its WebGPU resources via `.unload()`. The targeted analogue of
 * `evictAllExcept` — same in-flight-inference deferral, so if the engine
 * has callers mid-`chat.completions.create()` the `.unload()` is parked in
 * `pendingUnload` and drained by `releaseInference`. No-op when the id isn't
 * resident.
 *
 * Module-local — `clearModel` is the only caller (mirrors `evictAllExcept`,
 * which is likewise unexported).
 */
function unloadEngine(modelId: string): void {
  const engine = loadedEngines.get(modelId);
  if (!engine) return;
  loadedEngines.delete(modelId);
  if ((inflightInferenceCount.get(modelId) ?? 0) > 0) {
    // Park the unload — releaseInference drains it when the last mid-flight
    // inference call finishes (same contract as evictAllExcept).
    pendingUnload.set(modelId, engine);
    return;
  }
  engine.unload?.().catch((err: unknown) => {
    console.warn(`[webllm] unload failed for cleared model ${modelId}:`, err);
  });
}

/**
 * Clear a downloaded model from BOTH layers:
 *   1. The resident WebGPU/RAM engine — ours, via `unloadEngine`.
 *   2. The on-disk IndexedDB cache — WebLLM's `deleteModelAllInfoInCache`,
 *      which drops the model tensors + tokenizer + wasm + chat config (the
 *      same `prebuiltAppConfig` scope our `CreateMLCEngine` loads write).
 *
 * Resets the per-model one-shot telemetry flags so a later re-download fires
 * `webllm_download_started` / `webllm_loaded` again rather than silently
 * skipping (the flags exist to dedupe *retries of a live session*, not to
 * mask a genuine fresh download after the user wiped the cache).
 *
 * `clearModel` targets a model the picker shows as already cached and idle,
 * so no load is in flight for it; pending loads are therefore not cancelled.
 */
export async function clearModel(modelId: string): Promise<void> {
  unloadEngine(modelId);
  const { deleteModelAllInfoInCache } = await import("@mlc-ai/web-llm");
  await deleteModelAllInfoInCache(modelId);
  downloadStartedFiredFor.delete(modelId);
  loadedFiredFor.delete(modelId);
}

/** Test-only: drop caches and one-shot flags between tests. */
export function _resetEngineCacheForTesting(): void {
  loadedEngines.clear();
  pendingByModelId.clear();
  downloadStartedFiredFor.clear();
  loadedFiredFor.clear();
  inflightInferenceCount.clear();
  pendingUnload.clear();
  serialChain = Promise.resolve();
}

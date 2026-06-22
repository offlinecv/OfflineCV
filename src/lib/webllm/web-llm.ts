// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 *   - The per-rewrite first-success flags
 *     (`webllm_first_rewrite`/`webllm_first_section_rewrite`) live in
 *     `rewrite-bullet.ts` / `rewrite-section.ts` respectively.
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
 * Lazily import and construct the WebLLM engine for `modelId`.
 *
 * Fast paths (no chaining):
 *   - Same model already loaded → returns the engine immediately. NOTE: a
 *     queued cross-model load can subsequently `evictAllExcept` + `.unload()`
 *     this engine before the caller awaits inference on it. Unreachable with
 *     the current single-picker consumer (rows are disabled while a load is
 *     in-flight, so two cross-model loads can't be in flight while a third
 *     caller is mid-stream on the loaded model), but a future multi-consumer
 *     caller would need to acquire a lock around `chat.completions.create()`
 *     to be safe.
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
 */
function evictAllExcept(keepId: string): void {
  for (const [id, engine] of loadedEngines) {
    if (id === keepId) continue;
    loadedEngines.delete(id);
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

/** Test-only: drop caches and one-shot flags between tests. */
export function _resetEngineCacheForTesting(): void {
  loadedEngines.clear();
  pendingByModelId.clear();
  downloadStartedFiredFor.clear();
  loadedFiredFor.clear();
  serialChain = Promise.resolve();
}

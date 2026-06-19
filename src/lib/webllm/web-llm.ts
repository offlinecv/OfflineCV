// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { trackWebllmDownloadStarted, trackWebllmLoaded } from "../analytics.ts";
import type { ProgressUpdate, WebLlmEngine } from "./types.ts";

/**
 * Per-model WebLLM engine cache + loader.
 *
 * #64 moves us off a single pinned `MODEL_ID` constant and onto a registry
 * (see `models.ts`). Every cache slot, every progress-callback subscription,
 * and every one-shot telemetry flag is now keyed by model id.
 *
 * Cache shape: at most one entry per model id; in steady state (no concurrent
 * cross-model calls) at most one entry total. Multi-GB quantized models held
 * concurrently in WebGPU memory will OOM consumer hardware, so each new
 * cross-model load evicts the prior entry FIRST and asks the prior engine to
 * `.unload()` itself — see `evictAllExcept` for the resource-release path
 * and the spec note about "if exposes one, otherwise delete the Map entry
 * and let GC reclaim it." Two trade-offs follow:
 *
 *   1. **Failure-during-switch leaves no engine.** If the user is on model A
 *      and asks for model B, A is evicted+unloaded before B starts. If B's
 *      load then fails (OOM, dropped network), the user is stuck with neither
 *      engine; the retry path is "click Y again", which starts fresh. The
 *      alternative (defer eviction until B resolves) doubles peak VRAM and
 *      can itself OOM mid-swap on a 4 GB GPU, which is the failure we're
 *      guarding against. The picker in PR B should surface this trade-off
 *      ("loading Y will unload X; if Y fails, click X to reload X").
 *   2. **Concurrent cross-model loads bypass the eviction guard.** Two
 *      `loadEngine(A,...)` and `loadEngine(B,...)` calls issued in the same
 *      microtask (before either populates the cache) each see an empty cache
 *      and each begin a load — two engines downloading concurrently. PR A
 *      consumers (RewriteButton, SectionRewrite) only ever pass
 *      `DEFAULT_MODEL_ID`, so this race is currently unreachable. PR B's
 *      picker MUST serialize cross-model `loadEngine` calls (e.g., chain
 *      them through a single in-flight promise) before exposing the
 *      multi-model surface.
 *
 * Both behaviors have explicit tests in `web-llm.test.ts` to pin them so a
 * future refactor doesn't accidentally change them silently.
 *
 * Telemetry rules (per #64 AC):
 *   - `webllm_download_started({ model })` fires once per model id, ever
 *     (per page). Retries of a previously-failed model do NOT double-fire.
 *   - `webllm_loaded({ model })` fires once per model id, ever.
 *   - The per-rewrite first-success flags (`webllm_first_rewrite`,
 *     `webllm_first_section_rewrite`) are model-dimensioned in their own
 *     modules; this file owns only download/loaded.
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

const engineCache = new Map<string, Promise<CacheableEngine>>();
const downloadStartedFiredFor = new Set<string>();
const loadedFiredFor = new Set<string>();

/**
 * Lazily import and construct the WebLLM engine for `modelId`.
 *
 * The dynamic `import("@mlc-ai/web-llm")` keeps the entry chunk small:
 * Rollup emits the WebLLM module as its own chunk, and the browser only
 * downloads it on first call. The constructed engine is cached for the page
 * lifetime under its model id, so subsequent calls (and concurrent calls
 * from multiple `SectionRewrite` instances for the SAME model id) all share
 * one load.
 *
 * Switching models: if `modelId` is NOT cached, every other entry is evicted
 * (and its engine `.unload()`'d, if exposed) before the new load begins.
 * See the file docstring for the failure-during-switch and concurrent-
 * cross-model trade-offs that follow from "evict first."
 *
 * On failure (OOM, dropped network, etc.) only the failing model's slot is
 * reset so the UI's "Try again" can re-attempt that model. The original
 * promise still rejects to the caller — the `.catch` here only resets the
 * slot. `downloadStartedFiredFor` deliberately keeps the model's flag set,
 * so a retry doesn't double-fire `webllm_download_started` for the same
 * logical attempt (per #64 AC).
 */
export function loadEngine(
  modelId: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<WebLlmEngine> {
  const existing = engineCache.get(modelId);
  if (existing) return existing;

  // Evict before starting the new load (not after) so peak VRAM stays at
  // one model's footprint, not the sum. See file docstring for the
  // failure-during-switch trade-off this creates.
  evictAllExcept(modelId);

  if (!downloadStartedFiredFor.has(modelId)) {
    downloadStartedFiredFor.add(modelId);
    trackWebllmDownloadStarted({ model: modelId });
  }

  const pending = (async (): Promise<CacheableEngine> => {
    const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
    const engine = (await CreateMLCEngine(modelId, {
      initProgressCallback: (report) => onProgress(report),
    })) as unknown as CacheableEngine;
    if (!loadedFiredFor.has(modelId)) {
      loadedFiredFor.add(modelId);
      trackWebllmLoaded({ model: modelId });
    }
    return engine;
  })();

  engineCache.set(modelId, pending);
  pending.catch(() => {
    if (engineCache.get(modelId) === pending) engineCache.delete(modelId);
  });
  return pending;
}

/**
 * Drop every cached engine except `keepId` and ask each to release its
 * WebGPU resources via `.unload()` if it exposes one — JS GC doesn't free
 * WebGPU allocations on its own.
 *
 * The spec covers both cases: "call teardown/unload/dispose if it exposes
 * one, otherwise delete the Map entry and let GC reclaim it." Map deletion
 * is unconditional; `unload()` is best-effort.
 *
 * Unload is fire-and-forget on the resolved promise — if a load was in
 * flight when eviction hit, we wait for it to finish before unloading
 * (and silently swallow a failed load; nothing to unload in that case).
 * Errors from `unload()` itself are also swallowed to keep them from
 * surfacing as unhandled rejections; eviction is fire-and-forget by
 * design.
 */
function evictAllExcept(keepId: string): void {
  for (const [id, enginePromise] of engineCache) {
    if (id === keepId) continue;
    engineCache.delete(id);
    enginePromise.then(
      (engine) => {
        // Best-effort unload. Silence any rejection so a flaky unload
        // doesn't trigger an unhandled-promise-rejection warning.
        engine.unload?.().catch(() => {});
      },
      () => {
        // Load already failed — no engine to unload.
      },
    );
  }
}

/** Test-only: drop caches and one-shot flags between tests. */
export function _resetEngineCacheForTesting(): void {
  engineCache.clear();
  downloadStartedFiredFor.clear();
  loadedFiredFor.clear();
}

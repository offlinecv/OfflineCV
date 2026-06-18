// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { trackWebllmDownloadStarted, trackWebllmLoaded } from "../analytics.ts";
import type { ProgressUpdate, WebLlmEngine } from "./types.ts";

/**
 * Pinned model ID. Single source of truth — never inline this string.
 *
 * Qwen2.5-1.5B-Instruct is the right size/quality tradeoff for the resume
 * rewrite task on consumer hardware (~1.2GB quantized). Multi-model selection
 * is out of scope here and lives behind a model registry (issue #64).
 */
export const MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

let cached: Promise<WebLlmEngine> | null = null;
let downloadStartedFired = false;
let loadedFired = false;

/**
 * Lazily import and construct the WebLLM engine.
 *
 * The dynamic `import("@mlc-ai/web-llm")` is what keeps the entry chunk
 * small: Rollup emits the WebLLM module as its own chunk, and the browser
 * only downloads it on first click. The constructed engine is cached for
 * the page lifetime so subsequent clicks (and concurrent clicks from
 * multiple bullet rows) all share one engine and one download.
 *
 * On failure (OOM, dropped network, etc.) the cache is reset to `null` so
 * the UI's "Try again" button can re-attempt. The original promise still
 * rejects to the caller — the `.catch` here only resets the slot.
 * `downloadStartedFired` deliberately stays `true` so a retry doesn't
 * double-fire `webllm_download_started` for the same logical attempt.
 *
 * Telemetry: fires `webllm_download_started` on the first call and
 * `webllm_loaded` once the engine is ready. Both fire at most once per page.
 */
export function loadEngine(
  onProgress: (update: ProgressUpdate) => void,
): Promise<WebLlmEngine> {
  if (cached) return cached;
  if (!downloadStartedFired) {
    downloadStartedFired = true;
    trackWebllmDownloadStarted();
  }
  const pending = (async () => {
    const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
    const engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report) => onProgress(report),
    });
    if (!loadedFired) {
      loadedFired = true;
      trackWebllmLoaded();
    }
    return engine as unknown as WebLlmEngine;
  })();
  cached = pending;
  pending.catch(() => {
    if (cached === pending) cached = null;
  });
  return pending;
}

/** Test-only: drop caches and one-shot flags between tests. */
export function _resetEngineCacheForTesting(): void {
  cached = null;
  downloadStartedFired = false;
  loadedFired = false;
}

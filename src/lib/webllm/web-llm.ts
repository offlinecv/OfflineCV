// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { trackWebllmDownloadStarted, trackWebllmLoaded } from "../analytics.ts";
import type { ProgressUpdate, WebLlmEngine } from "./types.ts";

/**
 * Pinned model ID. Single source of truth — never inline this string.
 *
 * Qwen2-1.5B-Instruct is the right size/quality tradeoff for the per-bullet
 * rewrite task on consumer hardware (~1.2GB quantized). Swapping models is
 * out of scope for v1 (see issue #3, Out-of-scope §); a measurement-backed
 * swap to Phi-3 or Llama-3 can revisit this constant.
 */
export const MODEL_ID = "Qwen2-1.5B-Instruct-q4f16_1-MLC";

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
  cached = (async () => {
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
  return cached;
}

/** Test-only: drop caches and one-shot flags between tests. */
export function _resetEngineCacheForTesting(): void {
  cached = null;
  downloadStartedFired = false;
  loadedFired = false;
}

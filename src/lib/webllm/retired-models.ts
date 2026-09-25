// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * One-time cleanup after the model picker was retired (#1015).
 *
 * A user of the picker can have up to three multi-GB models cached that the
 * app will never load again, plus the picker's own `localStorage` keys. On the
 * first page load after the change this deletes both, silently, and records
 * that it ran so it never runs again:
 *
 *   - Weights: every Cache API entry a retired model owns, in the three
 *     scopes web-llm writes with its default `"cache"` backend
 *     (`webllm/model`, `webllm/config`, `webllm/wasm`). An entry belongs to a
 *     retired model when its URL sits under that model's Hugging Face base
 *     (`https://huggingface.co/mlc-ai/<id>/` — shards, `tensor-cache.json`,
 *     tokenizer, `mlc-chat-config.json`) or is its model library wasm. The
 *     shipped model's URLs match neither, so its cache is never touched.
 *   - Keys: the picker's selection (`offlinecv:webllm:modelId`) and its
 *     license-type consent (`offlinecv:webllm:consent:<LicenseType>`). The
 *     latter is removed, not migrated, on purpose — consent is now keyed to a
 *     model id, and an acceptance of Llama's license is not an acceptance of
 *     Gemma's terms.
 *
 * **It must not reach the network, and it does not use web-llm.** The cache
 * facts it relies on are `model-cache.ts`'s. web-llm's
 * `deleteModelAllInfoInCache` (behind `clearModel`) reads `tensor-cache.json`
 * through `fetchWithCache`, which `cache.add()`s — a GET to huggingface.co —
 * whenever the entry is missing. Called for a model that was never cached, it
 * would make that request before any consent and leave the fetched JSON
 * behind. Reading and deleting cache entries directly costs no request, needs
 * no multi-MB web-llm chunk, and also clears a half-finished download that
 * web-llm's own path would miss. `caches.has` is checked before `caches.open`
 * so a visitor who never used on-device AI gets no empty cache created.
 *
 * It must cost the page nothing. It runs from an idle callback and probes
 * nothing — no WebGPU check, no capability telemetry: a browser that never
 * loaded a model has no `webllm/*` cache, so the scan is three `has` calls.
 * It fails open: each error is logged, never shown, and one model's failed
 * removal does not stop the next. Only a failure outside those per-model
 * steps leaves the done flag unset, so the cleanup runs again on the next
 * load.
 */

import { modelRepoUrl, openExistingWebLlmCaches } from "./model-cache.ts";

interface RetiredModel {
  /** `model_id` the picker loaded. */
  readonly id: string;
  /** File name of its model library, the one `webllm/wasm` entry it owns. */
  readonly modelLib: string;
}

/**
 * Models the picker offered that are no longer shipped. `modelLib` is the
 * last segment of each record's `model_lib` in web-llm 0.2.84's
 * `prebuiltAppConfig`; it is matched as a suffix so a wasm cached under an
 * older pin's version prefix is removed too.
 */
const RETIRED_MODELS: readonly RetiredModel[] = [
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", modelLib: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", modelLib: "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm" },
  { id: "gemma3-1b-it-q4f16_1-MLC", modelLib: "gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm" },
];

export const RETIRED_MODEL_IDS: readonly string[] = RETIRED_MODELS.map((m) => m.id);

/** `localStorage` keys the picker wrote. */
export const RETIRED_STORAGE_KEYS: readonly string[] = [
  "offlinecv:webllm:modelId",
  "offlinecv:webllm:consent:Apache-2.0",
  "offlinecv:webllm:consent:Restricted-Community",
];

/** Set once the cleanup has run; its presence is the whole signal. */
export const RETIRED_CLEANUP_DONE_KEY = "offlinecv:webllm:retired-models-cleaned";

function readDone(): boolean {
  try {
    return globalThis.localStorage?.getItem(RETIRED_CLEANUP_DONE_KEY) !== null;
  } catch {
    return false;
  }
}

function removeKey(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch (err) {
    console.warn(`[webllm] could not remove retired key ${key}:`, err);
  }
}

function ownedBy(url: string, model: RetiredModel): boolean {
  return url.startsWith(modelRepoUrl(model.id)) || url.endsWith(`/${model.modelLib}`);
}

interface OpenScope {
  readonly cache: Cache;
  readonly requests: readonly Request[];
}

async function withKeys(caches: readonly Cache[]): Promise<OpenScope[]> {
  return Promise.all(caches.map(async (cache) => ({ cache, requests: await cache.keys() })));
}

async function removeModelEntries(scopes: readonly OpenScope[], model: RetiredModel): Promise<void> {
  for (const { cache, requests } of scopes) {
    for (const request of requests) {
      if (ownedBy(request.url, model)) await cache.delete(request);
    }
  }
}

/**
 * Delete the retired models' cached files and the picker's keys, once.
 * Never rejects.
 */
export async function cleanUpRetiredModels(): Promise<void> {
  if (readDone()) return;
  try {
    for (const key of RETIRED_STORAGE_KEYS) removeKey(key);

    const store = globalThis.caches;
    if (store !== undefined) {
      const scopes = await withKeys(await openExistingWebLlmCaches(store));
      for (const model of RETIRED_MODELS) {
        try {
          await removeModelEntries(scopes, model);
        } catch (err) {
          console.warn(`[webllm] could not remove retired model ${model.id}:`, err);
        }
      }
    }

    globalThis.localStorage?.setItem(RETIRED_CLEANUP_DONE_KEY, "1");
  } catch (err) {
    console.warn("[webllm] retired-model cleanup failed:", err);
  }
}

/**
 * Run `cleanUpRetiredModels` once the page is idle, so it never competes with
 * first paint. Called from each entry's `main.tsx`.
 */
export function scheduleRetiredModelCleanup(): void {
  if (readDone()) return;
  const run = () => void cleanUpRetiredModels();
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback(run, { timeout: 10_000 });
  } else {
    setTimeout(run, 2_000);
  }
}

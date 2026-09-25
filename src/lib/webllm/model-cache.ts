// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Where web-llm keeps a model on disk, read without web-llm and without the
 * network (#1015).
 *
 * Two callers need to ask "is anything of model X on this device?" at a time
 * when neither may pay for the answer: the status line probes on mount, and
 * the retired-model cleanup runs on every first page load. Going through
 * web-llm for that costs the multi-MB web-llm chunk, and some of its cache
 * helpers are not read-only — `fetchWithCache` `cache.add()`s a missing entry,
 * which is a GET to huggingface.co. The Cache API itself is local, so this
 * module reads it directly.
 *
 * The facts below mirror `@mlc-ai/web-llm` 0.2.84 with its default `"cache"`
 * backend (offlinecv passes no `appConfig`): a model's files live in three
 * Cache API scopes, keyed by URL; everything but the model library wasm sits
 * under the record's `model` URL after web-llm's `cleanModelUrl` appends
 * `resolve/main/`; and the weights are complete when `tensor-cache.json` and
 * every shard its `records[].dataPath` lists are present — web-llm's own
 * `hasTensorInCache` test. `model-cache.test.ts` pins the URL shape against
 * the pinned `prebuiltAppConfig`, so a bump that changes it fails there.
 */

/** Cache API scopes web-llm's default backend writes a model into. */
export const WEBLLM_CACHE_SCOPES = {
  model: "webllm/model",
  config: "webllm/config",
  wasm: "webllm/wasm",
} as const;

const MODEL_URL_BASE = "https://huggingface.co/mlc-ai/";

/** `modelId`'s Hugging Face repository, the record's `model` plus a slash. */
export function modelRepoUrl(modelId: string): string {
  return `${MODEL_URL_BASE}${modelId}/`;
}

/** The URL every one of `modelId`'s weight, tokenizer and config files sits under. */
export function modelBaseUrl(modelId: string): string {
  return `${modelRepoUrl(modelId)}resolve/main/`;
}

/** The web-llm scopes that exist, opened. Creates no cache. */
export async function openExistingWebLlmCaches(
  store: CacheStorage,
): Promise<Cache[]> {
  const open: Cache[] = [];
  for (const scope of Object.values(WEBLLM_CACHE_SCOPES)) {
    if (await store.has(scope)) open.push(await store.open(scope));
  }
  return open;
}

interface TensorCacheManifest {
  records: { dataPath: string }[];
}

/**
 * Whether `modelId`'s weights are fully in the Cache API. Reads only; a
 * missing Cache API, a missing scope, a missing or malformed manifest, or any
 * error reads as `false`.
 */
export async function hasModelWeightsCached(modelId: string): Promise<boolean> {
  try {
    const store = globalThis.caches;
    if (store === undefined || !(await store.has(WEBLLM_CACHE_SCOPES.model))) {
      return false;
    }
    const cache = await store.open(WEBLLM_CACHE_SCOPES.model);
    const base = modelBaseUrl(modelId);
    const manifest = await cache.match(new URL("tensor-cache.json", base).href);
    if (manifest === undefined) return false;
    const { records } = (await manifest.json()) as TensorCacheManifest;
    const present = new Set((await cache.keys()).map((request) => request.url));
    return records.every((record) => present.has(new URL(record.dataPath, base).href));
  } catch {
    return false;
  }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `model-cache.ts` — the local, network-free reading of web-llm's Cache API
 * layout (#1015). Pins the URL shape against the pinned `prebuiltAppConfig`,
 * then checks the weights probe answers from cache contents alone.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

import { hasModelWeightsCached, modelBaseUrl, WEBLLM_CACHE_SCOPES } from "./model-cache.ts";
import { SHIPPED_MODEL } from "./models.ts";
import { RETIRED_MODEL_IDS } from "./retired-models.ts";

/** web-llm's `cleanModelUrl`, restated for the records the app depends on. */
function cleanedRecordUrl(modelId: string): string {
  const record = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
  if (!record) throw new Error(`${modelId} is not in prebuiltAppConfig`);
  const withSlash = record.model.endsWith("/") ? record.model : `${record.model}/`;
  return /.+\/resolve\/.+\//.test(withSlash) ? withSlash : `${withSlash}resolve/main/`;
}

function stubModelScope(entries: Record<string, unknown>): { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("caches", {
    has: async (scope: string) => scope === WEBLLM_CACHE_SCOPES.model,
    open: async () => ({
      match: async (url: string) =>
        url in entries ? { json: async () => entries[url] } : undefined,
      keys: async () => Object.keys(entries).map((url) => ({ url })),
    }),
  });
  return { fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelBaseUrl", () => {
  it("matches the cleaned record URL web-llm keys the shipped and retired models under", () => {
    for (const id of [SHIPPED_MODEL.id, ...RETIRED_MODEL_IDS]) {
      expect(modelBaseUrl(id)).toBe(cleanedRecordUrl(id));
    }
  });
});

describe("hasModelWeightsCached", () => {
  const base = modelBaseUrl(SHIPPED_MODEL.id);
  const manifest = { records: [{ dataPath: "params_shard_0.bin" }, { dataPath: "params_shard_1.bin" }] };

  it("is false without the Cache API", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await hasModelWeightsCached(SHIPPED_MODEL.id)).toBe(false);
  });

  it("is false with no manifest, and fetches nothing", async () => {
    const { fetch } = stubModelScope({});
    expect(await hasModelWeightsCached(SHIPPED_MODEL.id)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is false when a shard the manifest lists is missing", async () => {
    stubModelScope({
      [`${base}tensor-cache.json`]: manifest,
      [`${base}params_shard_0.bin`]: null,
    });
    expect(await hasModelWeightsCached(SHIPPED_MODEL.id)).toBe(false);
  });

  it("is true when the manifest and every shard are present", async () => {
    const { fetch } = stubModelScope({
      [`${base}tensor-cache.json`]: manifest,
      [`${base}params_shard_0.bin`]: null,
      [`${base}params_shard_1.bin`]: null,
    });
    expect(await hasModelWeightsCached(SHIPPED_MODEL.id)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a throwing store as not cached", async () => {
    vi.stubGlobal("caches", { has: () => Promise.reject(new Error("denied")) });
    expect(await hasModelWeightsCached(SHIPPED_MODEL.id)).toBe(false);
  });
});

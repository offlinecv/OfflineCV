// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one-time retired-model cleanup (#1015): it runs once, removes the
 * retired models' cache entries and the picker's keys, leaves the shipped
 * model's cache and consent alone, never reaches the network or web-llm, and
 * fails open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { webLlmImported } = vi.hoisted(() => ({ webLlmImported: vi.fn() }));
vi.mock("@mlc-ai/web-llm", () => {
  webLlmImported();
  return {};
});

import {
  cleanUpRetiredModels,
  RETIRED_CLEANUP_DONE_KEY,
  RETIRED_STORAGE_KEYS,
  scheduleRetiredModelCleanup,
} from "./retired-models.ts";
import { modelConsentKey } from "./consent.ts";
import { SHIPPED_MODEL } from "./models.ts";

const HF = "https://huggingface.co/mlc-ai/";
const WASM = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/";
const QWEN = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const QWEN_ENTRIES = {
  "webllm/model": [
    `${HF}${QWEN}/resolve/main/tensor-cache.json`,
    `${HF}${QWEN}/resolve/main/params_shard_0.bin`,
    `${HF}${QWEN}/resolve/main/tokenizer.json`,
  ],
  "webllm/config": [`${HF}${QWEN}/resolve/main/mlc-chat-config.json`],
  "webllm/wasm": [`${WASM}Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm`],
};
const SHIPPED_ENTRIES = {
  "webllm/model": [`${HF}${SHIPPED_MODEL.id}/resolve/main/tensor-cache.json`],
  "webllm/config": [`${HF}${SHIPPED_MODEL.id}/resolve/main/mlc-chat-config.json`],
  "webllm/wasm": [`${WASM}gemma-2-2b-it-q4f16_1_cs1k-webgpu.wasm`],
};

/**
 * In-memory `CacheStorage` over scope → URL set. `open` records the scopes it
 * is asked for, so a test can see the cleanup created no cache.
 */
function fakeCaches(seed: Record<string, string[]>[]) {
  const scopes = new Map<string, Set<string>>();
  for (const part of seed) {
    for (const [scope, urls] of Object.entries(part)) {
      const set = scopes.get(scope) ?? new Set<string>();
      for (const url of urls) set.add(url);
      scopes.set(scope, set);
    }
  }
  const opened: string[] = [];
  const deleteSpy = vi.fn(async (scope: string, url: string) => scopes.get(scope)?.delete(url) ?? false);
  const store = {
    has: vi.fn(async (scope: string) => scopes.has(scope)),
    open: vi.fn(async (scope: string) => {
      opened.push(scope);
      if (!scopes.has(scope)) scopes.set(scope, new Set());
      const set = scopes.get(scope)!;
      return {
        keys: async () => [...set].map((url) => ({ url }) as Request),
        delete: (req: Request) => deleteSpy(scope, req.url),
      } as unknown as Cache;
    }),
  };
  return { store, scopes, opened, deleteSpy };
}

function remaining(scopes: Map<string, Set<string>>): string[] {
  return [...scopes.values()].flatMap((set) => [...set]).sort();
}

function seedPickerKeys(): void {
  localStorage.setItem("offlinecv:webllm:modelId", QWEN);
  localStorage.setItem("offlinecv:webllm:consent:Apache-2.0", "accepted");
  localStorage.setItem("offlinecv:webllm:consent:Restricted-Community", "accepted");
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  webLlmImported.mockClear();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cleanUpRetiredModels", () => {
  it("with nothing cached: opens no cache, fetches nothing, never loads web-llm, and is done", async () => {
    const caches = fakeCaches([]);
    vi.stubGlobal("caches", caches.store);
    await cleanUpRetiredModels();
    expect(caches.opened).toEqual([]);
    expect(caches.deleteSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webLlmImported).not.toHaveBeenCalled();
    expect(localStorage.getItem(RETIRED_CLEANUP_DONE_KEY)).not.toBeNull();
  });

  it("removes only the cached retired model's entries and never the shipped model's", async () => {
    const caches = fakeCaches([QWEN_ENTRIES, SHIPPED_ENTRIES]);
    vi.stubGlobal("caches", caches.store);
    await cleanUpRetiredModels();
    expect(remaining(caches.scopes)).toEqual(Object.values(SHIPPED_ENTRIES).flat().sort());
    expect(caches.deleteSpy).toHaveBeenCalledTimes(Object.values(QWEN_ENTRIES).flat().length);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webLlmImported).not.toHaveBeenCalled();
  });

  it("clears a half-finished download that has no tensor-cache.json", async () => {
    const caches = fakeCaches([{ "webllm/config": QWEN_ENTRIES["webllm/config"] }]);
    vi.stubGlobal("caches", caches.store);
    await cleanUpRetiredModels();
    expect(remaining(caches.scopes)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without the Cache API: removes the keys and is still done", async () => {
    vi.stubGlobal("caches", undefined);
    seedPickerKeys();
    await cleanUpRetiredModels();
    expect(localStorage.getItem("offlinecv:webllm:modelId")).toBeNull();
    expect(localStorage.getItem(RETIRED_CLEANUP_DONE_KEY)).not.toBeNull();
  });

  it("removes the picker's selection and license-type consent keys, keeping the shipped model's consent", async () => {
    vi.stubGlobal("caches", fakeCaches([]).store);
    seedPickerKeys();
    localStorage.setItem(modelConsentKey(SHIPPED_MODEL.id), "accepted");
    await cleanUpRetiredModels();
    for (const key of RETIRED_STORAGE_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem(modelConsentKey(SHIPPED_MODEL.id))).toBe("accepted");
  });

  it("runs once: a second call after it finished does nothing", async () => {
    const caches = fakeCaches([]);
    vi.stubGlobal("caches", caches.store);
    await cleanUpRetiredModels();
    expect(localStorage.getItem(RETIRED_CLEANUP_DONE_KEY)).not.toBeNull();
    caches.store.has.mockClear();
    seedPickerKeys();

    await cleanUpRetiredModels();
    expect(caches.store.has).not.toHaveBeenCalled();
    expect(localStorage.getItem("offlinecv:webllm:modelId")).not.toBeNull();
  });

  it("fails open per model: one failed removal still attempts the rest, resolves, and marks done", async () => {
    const llama = `${HF}Llama-3.2-3B-Instruct-q4f16_1-MLC/resolve/main/tensor-cache.json`;
    const caches = fakeCaches([QWEN_ENTRIES, { "webllm/model": [llama] }]);
    caches.deleteSpy.mockRejectedValueOnce(new Error("cache busy"));
    vi.stubGlobal("caches", caches.store);
    await expect(cleanUpRetiredModels()).resolves.toBeUndefined();
    expect(remaining(caches.scopes)).not.toContain(llama);
    expect(localStorage.getItem(RETIRED_CLEANUP_DONE_KEY)).not.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("fails open overall: a throwing cache read resolves and leaves it to run again", async () => {
    vi.stubGlobal("caches", {
      has: vi.fn().mockRejectedValue(new Error("storage exploded")),
      open: vi.fn(),
    });
    await expect(cleanUpRetiredModels()).resolves.toBeUndefined();
    expect(localStorage.getItem(RETIRED_CLEANUP_DONE_KEY)).toBeNull();
  });
});

describe("scheduleRetiredModelCleanup", () => {
  it("defers the work instead of running it during the call", () => {
    vi.useFakeTimers();
    try {
      const caches = fakeCaches([]);
      vi.stubGlobal("caches", caches.store);
      scheduleRetiredModelCleanup();
      expect(caches.store.has).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules nothing once the cleanup is done", () => {
    localStorage.setItem(RETIRED_CLEANUP_DONE_KEY, "1");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    scheduleRetiredModelCleanup();
    expect(timeout).not.toHaveBeenCalled();
    timeout.mockRestore();
  });
});

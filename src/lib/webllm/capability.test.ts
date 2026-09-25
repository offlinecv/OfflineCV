// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCapabilityCacheForTesting,
  detectWebGpu,
} from "./capability.ts";

// We're stubbing `navigator` directly on globalThis. Vitest runs in node env,
// so `navigator` doesn't exist by default — assigning it is safe and the
// cleanup in afterEach restores the env.
const originalNavigator = (globalThis as { navigator?: unknown }).navigator;

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreNavigator(): void {
  if (originalNavigator === undefined) {
    delete (globalThis as { navigator?: unknown }).navigator;
  } else {
    setNavigator(originalNavigator);
  }
}

describe("detectWebGpu", () => {
  beforeEach(() => {
    _resetCapabilityCacheForTesting();
  });

  afterEach(() => {
    restoreNavigator();
    _resetCapabilityCacheForTesting();
  });

  it("returns 'no-webgpu' when navigator.gpu is missing", async () => {
    setNavigator({});
    await expect(detectWebGpu()).resolves.toBe("no-webgpu");
  });

  it("returns 'no-webgpu' when navigator itself is undefined", async () => {
    // Simulate a non-browser environment — `navigator` not on globalThis.
    delete (globalThis as { navigator?: unknown }).navigator;
    await expect(detectWebGpu()).resolves.toBe("no-webgpu");
  });

  it("returns 'available' when the adapter reports shader-f16", async () => {
    setNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({
          name: "Apple M1",
          features: { has: (f: string) => f === "shader-f16" },
        }),
      },
    });
    await expect(detectWebGpu()).resolves.toBe("available");
  });

  it("returns 'no-shader-f16' when the adapter's features don't include shader-f16", async () => {
    setNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({
          name: "Intel HD Graphics",
          features: { has: () => false },
        }),
      },
    });
    await expect(detectWebGpu()).resolves.toBe("no-shader-f16");
  });

  it("returns 'no-shader-f16' (fails closed) when the adapter has no features set", async () => {
    setNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({ name: "Apple M1" }),
      },
    });
    await expect(detectWebGpu()).resolves.toBe("no-shader-f16");
  });

  it("returns 'unsupported-os' when requestAdapter resolves to null", async () => {
    setNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(detectWebGpu()).resolves.toBe("unsupported-os");
  });

  it("returns 'unsupported-os' when requestAdapter throws", async () => {
    setNavigator({
      gpu: {
        requestAdapter: vi.fn().mockRejectedValue(new Error("driver missing")),
      },
    });
    await expect(detectWebGpu()).resolves.toBe("unsupported-os");
  });

  it("requests the adapter the way web-llm's detectGPUDevice does (high-performance)", async () => {
    // On a dual-GPU machine a different powerPreference can yield a different
    // adapter with a different feature set; the probe must inspect the one
    // the engine will actually use.
    const requestAdapter = vi.fn().mockResolvedValue({
      features: { has: (f: string) => f === "shader-f16" },
    });
    setNavigator({ gpu: { requestAdapter } });
    await detectWebGpu();
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
  });

  it("caches the result for the page lifetime — requestAdapter is called once", async () => {
    const requestAdapter = vi.fn().mockResolvedValue({ name: "GPU" });
    setNavigator({ gpu: { requestAdapter } });
    await detectWebGpu();
    await detectWebGpu();
    await detectWebGpu();
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});

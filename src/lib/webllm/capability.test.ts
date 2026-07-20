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

  it("returns 'available' when navigator.gpu.requestAdapter resolves to an adapter", async () => {
    setNavigator({
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({ name: "Apple M1" }),
      },
    });
    await expect(detectWebGpu()).resolves.toBe("available");
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

  it("caches the result for the page lifetime — requestAdapter is called once", async () => {
    const requestAdapter = vi.fn().mockResolvedValue({ name: "GPU" });
    setNavigator({ gpu: { requestAdapter } });
    await detectWebGpu();
    await detectWebGpu();
    await detectWebGpu();
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});

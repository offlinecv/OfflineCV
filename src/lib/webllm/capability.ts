// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { trackWebllmCapabilityDetected } from "../analytics.ts";
import type { WebGpuCapability } from "./types.ts";

// Minimal shape we need from `navigator.gpu` — typed inline so we don't depend
// on `@webgpu/types` being installed.
interface GpuLike {
  requestAdapter: () => Promise<unknown>;
}

let cached: Promise<WebGpuCapability> | null = null;

/**
 * Detect whether the current browser can run a WebLLM model on-device.
 *
 * - `"no-webgpu"` — `navigator.gpu` is missing (Firefox without flags, iOS
 *   Safari pre-18, Chrome with WebGPU disabled).
 * - `"unsupported-os"` — `navigator.gpu` exists but no adapter is returned
 *   (typical on a machine without a discrete/integrated GPU driver, or on a
 *   linux desktop without Vulkan).
 * - `"available"` — adapter granted, the rewrite path is safe to attempt.
 *
 * The result is cached for the page lifetime: a session-stable signal that
 * also lets us fire `webllm_capability_detected` exactly once.
 */
export function detectWebGpu(): Promise<WebGpuCapability> {
  if (cached) return cached;
  cached = (async () => {
    const result = await detectInternal();
    trackWebllmCapabilityDetected(result);
    return result;
  })();
  return cached;
}

async function detectInternal(): Promise<WebGpuCapability> {
  const gpu = getGpu();
  if (!gpu) return "no-webgpu";
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? "available" : "unsupported-os";
  } catch {
    // requestAdapter is allowed to throw on some Android builds.
    return "unsupported-os";
  }
}

function getGpu(): GpuLike | null {
  if (typeof navigator === "undefined") return null;
  const gpu = (navigator as { gpu?: GpuLike }).gpu;
  return gpu ?? null;
}

/** Test-only: drop the cached promise so each test sees a fresh detection. */
export function _resetCapabilityCacheForTesting(): void {
  cached = null;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { trackWebllmCapabilityDetected } from "../analytics.ts";
import type { WebGpuCapability } from "./types.ts";

// Minimal shape we need from `navigator.gpu` — typed inline so we don't depend
// on `@webgpu/types` being installed.
interface GpuLike {
  requestAdapter: (
    options?: GpuRequestAdapterOptionsLike,
  ) => Promise<GpuAdapterLike | null>;
}

interface GpuRequestAdapterOptionsLike {
  powerPreference?: "low-power" | "high-performance";
}

/**
 * The exact options web-llm's `detectGPUDevice` passes to `requestAdapter`
 * (`@mlc-ai/web-llm` 0.2.84, `lib/index.js`: `powerPreference =
 * "high-performance"`). On a machine with more than one GPU the browser may
 * answer a different `powerPreference` with a different adapter (integrated
 * vs discrete), and the two need not share a feature set — so the probe
 * must ask the same way the engine will, or it inspects an adapter the
 * engine never uses and its `shader-f16` verdict is about the wrong GPU.
 */
const ADAPTER_REQUEST_OPTIONS: GpuRequestAdapterOptionsLike = {
  powerPreference: "high-performance",
};

// `GPUSupportedFeatures` is set-like (`has()`), not a plain object — this is
// the minimal shape `requestAdapter()`'s result needs for the shader-f16
// check below. An adapter is expected to carry `features`, but we don't
// trust that across browsers/mocks, so `detectInternal` treats a missing
// `features` as "not available" rather than assuming support (#1019).
interface GpuAdapterLike {
  features?: { has: (feature: string) => boolean };
}

/** The one MLC-required feature the shipped model needs (see `models.ts`). */
const REQUIRED_GPU_FEATURE = "shader-f16";

let cached: Promise<WebGpuCapability> | null = null;

/**
 * Detect whether the current browser can run a WebLLM model on-device.
 *
 * - `"no-webgpu"` — `navigator.gpu` is missing (Firefox without flags, iOS
 *   Safari pre-18, Chrome with WebGPU disabled).
 * - `"unsupported-os"` — `navigator.gpu` exists but no adapter is returned
 *   (typical on a machine without a discrete/integrated GPU driver, or on a
 *   linux desktop without Vulkan).
 * - `"no-shader-f16"` — an adapter was granted but it doesn't report the
 *   `shader-f16` feature the shipped model requires (`SHIPPED_MODEL` in
 *   `models.ts` lists it in `required_features`). Without this check the
 *   probe reads as available, the user accepts the model's terms, and
 *   `CreateMLCEngine` only then rejects with a load error (#1019). An
 *   adapter with no `features` set at all is treated the same way — fail
 *   closed rather than assume support.
 * - `"available"` — adapter granted and reports `shader-f16`, the rewrite
 *   path is safe to attempt.
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
    const adapter = await gpu.requestAdapter(ADAPTER_REQUEST_OPTIONS);
    if (!adapter) return "unsupported-os";
    // Fail closed: no `features` set at all reads as unsupported rather than
    // assuming the shipped model's required feature is present.
    if (!adapter.features?.has(REQUIRED_GPU_FEATURE)) return "no-shader-f16";
    return "available";
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

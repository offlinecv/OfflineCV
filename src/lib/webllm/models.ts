// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Curated WebLLM model registry — what the user can pick from.
 *
 * Replaces the single `MODEL_ID` constant the per-bullet pilot shipped with.
 * Every model exposed in the UI must have a row here so the engine cache,
 * picker, telemetry, and consent gate can read off one source of truth.
 *
 * Three constraints shape this list:
 *
 *   1. License — resumelint is Apache-2.0. The default MUST be Apache-2.0
 *      (Qwen2.5-1.5B) so every install works without surfacing a
 *      Restricted-Community consent modal up front. Gemma + Llama ship as
 *      opt-in extras gated by the consent modal (see #64 Step 5).
 *   2. Download size — every entry is multi-GB; the picker surfaces the
 *      `downloadSizeMb` so the user can opt out before the network blows up.
 *   3. Tier — advisory display label only. Tiers do NOT auto-route. A
 *      capability probe in `capability.ts` MAY annotate a "recommended for
 *      your device" hint in the picker, but it never auto-loads a higher-
 *      tier model. See #64 spec for why.
 *
 * Each `id` is the exact `model_id` in `@mlc-ai/web-llm`'s
 * `prebuiltAppConfig.model_list` — verified against the pinned version
 * (`@mlc-ai/web-llm@0.2.84`) before this file shipped. Bumping the web-llm
 * pin requires re-verifying these IDs against the new `prebuiltAppConfig`,
 * because MLC has renamed model_ids across minor releases before.
 *
 * `downloadSizeMb` is pulled from `vram_required_MB` in the same
 * prebuiltAppConfig entry (rounded down to int). VRAM and download bytes
 * track closely for 4-bit quantized models; close enough for the picker's
 * "this download is ~1.6 GB" UI.
 */

export type LicenseType = "Apache-2.0" | "Restricted-Community";
export type ModelTier = "Low" | "Standard" | "High";

export interface ModelMetadata {
  /** Exact `model_id` from `@mlc-ai/web-llm`'s `prebuiltAppConfig.model_list`. */
  id: string;
  /** Human-readable name for the picker. */
  name: string;
  /** SPDX-style license tag. `Restricted-Community` triggers the consent gate. */
  licenseType: LicenseType;
  /** Advisory display tier — Low/Standard/High. NOT a routing signal. */
  tier: ModelTier;
  /**
   * Required for `Restricted-Community` models. The consent modal displays
   * this link so the user can read the vendor's terms before accepting.
   * Apache-2.0 models omit it (license is well-known).
   */
  licenseUrl?: string;
  /**
   * Approximate one-time download size in megabytes, surfaced in the picker
   * before the user commits to a fresh download. Sourced from the pinned
   * web-llm version's `vram_required_MB` (4-bit quantized models' VRAM and
   * download bytes track within ~5% of each other).
   */
  downloadSizeMb: number;
}

/**
 * The three models the user can pick from. Order matters: this is also the
 * picker's display order (Apache-2.0 first, then Restricted-Community by
 * tier).
 *
 * If you add a row, also:
 *   1. Verify the `id` exists in the pinned `@mlc-ai/web-llm`'s
 *      `prebuiltAppConfig.model_list`.
 *   2. Confirm `vram_required_MB` from the same entry → `downloadSizeMb`.
 *   3. If `licenseType: 'Restricted-Community'`, set `licenseUrl` AND record
 *      a license-vetting result on the tracking issue before merging.
 */
export const MODEL_REGISTRY: readonly ModelMetadata[] = [
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 (1.5B)",
    licenseType: "Apache-2.0",
    tier: "Low",
    downloadSizeMb: 1630,
  },
  {
    id: "gemma-2-2b-it-q4f16_1-MLC",
    name: "Gemma 2 (2B)",
    licenseType: "Restricted-Community",
    tier: "Standard",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    downloadSizeMb: 1895,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 (3B)",
    licenseType: "Restricted-Community",
    tier: "High",
    licenseUrl: "https://www.llama.com/llama3_2/license/",
    downloadSizeMb: 2264,
  },
];

/**
 * The model loaded when the user has not made an explicit pick.
 *
 * MUST be Apache-2.0 — every install gets this without triggering a
 * Restricted-Community consent modal. A user-persisted `localStorage`
 * selection (PR B) is the ONLY override; no hardware auto-routing.
 */
export const DEFAULT_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

/** Look up a model by id. Returns undefined for unknown ids. */
export function getModelById(id: string): ModelMetadata | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** True when the given model id is in the registry. */
export function isRegisteredModelId(id: string): boolean {
  return MODEL_REGISTRY.some((m) => m.id === id);
}

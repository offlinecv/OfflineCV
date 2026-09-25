// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one on-device model offlinecv ships (#1015).
 *
 * Every WebLLM feature — section and whole-résumé rewrite, critique, the
 * parse escape hatch, semantic JD match, sector classification — loads this
 * model and no other. There is no picker: a per-user model choice confused
 * people more than it helped them, and with one model there is one download,
 * one consent, and one set of behaviour to reason about.
 *
 * ## Why Gemma 2 (2B)
 *
 * The choice rests on the maintainer's hands-on runs, not on the automated
 * rewrite eval. Side by side, Gemma 2 produced better rewrites than Qwen 2.5
 * (1.5B), which shipped before it, and Gemma 3 (1B), which echoed the prompt's
 * instructions back and looped. Be honest about what the eval said, though:
 * the #65 rewrite eval scored Gemma 2 at 54% against Qwen 2.5's 67% (reports
 * under `tests/fixtures/rewrite/reports/`). Those numbers and the hands-on
 * results disagree, and this switch does not resolve that. Any future model
 * change should be measured with the dev-only eval harness
 * (`src/lib/webllm/eval/README.md`), which keeps a candidate list for that
 * purpose — candidates live there, never here.
 *
 * ## Why consent is required
 *
 * Gemma is not Apache-2.0: its weights are released under Google's Gemma
 * Terms of Use. Nothing downloads until the user has accepted those terms,
 * and the acceptance is keyed to this model's `id` (`consent.ts`), so a
 * change of model asks again. `loadEngine` refuses to start without it.
 *
 * ## Facts pinned to `@mlc-ai/web-llm`
 *
 * `id` is the `model_id` in the pinned web-llm's `prebuiltAppConfig`
 * (0.2.84). Bumping the pin means re-checking it, because MLC has renamed
 * model ids across minor releases. `downloadSizeMb` is that record's
 * `vram_required_MB` rounded down — VRAM and download bytes track within a few
 * percent for 4-bit quantized weights, close enough for a "~1.9 GB" label. The
 * same record lists `required_features: ["shader-f16"]` and a 4096-token
 * context window; the capability probe in `capability.ts` does not check for
 * the feature, so a GPU without f16 shaders reaches a load error rather than
 * a "not supported" notice.
 */

import type { ModelLoadSource } from "./types.ts";

export interface ModelMetadata {
  /** `model_id` in `@mlc-ai/web-llm`'s `prebuiltAppConfig.model_list`. */
  id: string;
  /** Human-readable name shown in the status line and the consent dialog. */
  name: string;
  /** The vendor's terms, linked from the consent dialog before any download. */
  licenseUrl: string;
  /** Approximate one-time download size in megabytes. */
  downloadSizeMb: number;
}

export const SHIPPED_MODEL: ModelMetadata = Object.freeze({
  id: "gemma-2-2b-it-q4f16_1-MLC",
  name: "Gemma 2 (2B)",
  licenseUrl: "https://ai.google.dev/gemma/terms",
  downloadSizeMb: 1895,
});

/** A model's download size as the UI states it, e.g. "~1.9 GB". */
export function downloadSizeLabel(model: ModelMetadata): string {
  return `~${(model.downloadSizeMb / 1024).toFixed(1)} GB`;
}

/**
 * The one headline every load-progress bar shows for the shipped model
 * (#1015). It names the download only when `loadEngine` found the weights
 * missing: a reload after a refresh or a `/` ↔ `/jobs/` navigation reads them
 * from Cache Storage, and calling that a "one-time download" every time made
 * the model look as if it re-downloaded on each rewrite.
 */
export function shippedModelLoadLabel(source: ModelLoadSource | undefined): string {
  const { name } = SHIPPED_MODEL;
  if (source === "device") return `Loading ${name} from this device`;
  if (source === "network") {
    return `Downloading ${name} (${downloadSizeLabel(SHIPPED_MODEL)}, one time)`;
  }
  return `Loading ${name}`;
}

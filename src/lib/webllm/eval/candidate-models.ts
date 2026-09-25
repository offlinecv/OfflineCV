// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Models a developer can run through the dev-only eval harnesses to compare
 * against the shipped one (#1015).
 *
 * The product ships one model (`SHIPPED_MODEL` in `../models.ts`) and has no
 * picker. Measuring a possible replacement still needs a way to load other
 * models, and that is this list. It is imported only by the harness entries
 * (`run-eval-browser.ts`, `../parse-eval/parse-eval-browser.ts`,
 * `../spike/jd-spike-browser.ts`) and the report formatter they use; their
 * HTML pages are not in `vite.config.ts`'s `rollupOptions.input`, so nothing
 * here reaches the production bundle.
 *
 * To try a model, append its `model_id` from the pinned `@mlc-ai/web-llm`'s
 * `prebuiltAppConfig.model_list`. Qwen 2.5 and Llama 3.2 are here because the
 * #65 eval measured them. Gemma 3 (1B) is not: web-llm 0.2.84's prebuilt
 * record leaves the model's `sliding_window_size` positive beside its
 * `context_window_size`, and the engine refuses to load that combination.
 */

import { SHIPPED_MODEL } from "../models.ts";
import { recordModelConsent } from "../consent.ts";
import { loadEngine } from "../web-llm.ts";
import type { ProgressUpdate, WebLlmEngine } from "../types.ts";

export interface EvalModel {
  /** `model_id` in the pinned web-llm's `prebuiltAppConfig.model_list`. */
  id: string;
  /** Label for the harness dropdown and the report's model column. */
  name: string;
}

/** The shipped model first — it is every harness's default selection. */
export const EVAL_MODELS: readonly EvalModel[] = [
  { id: SHIPPED_MODEL.id, name: SHIPPED_MODEL.name },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 (1.5B)" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", name: "Llama 3.2 (3B)" },
];

export function findEvalModel(id: string): EvalModel | undefined {
  return EVAL_MODELS.find((m) => m.id === id);
}

/** Fill a harness `<select>` with `EVAL_MODELS`, shipped model selected. */
export function fillEvalModelSelect(select: HTMLSelectElement): void {
  select.innerHTML = "";
  for (const model of EVAL_MODELS) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent =
      model.id === SHIPPED_MODEL.id ? `${model.name} · shipped` : model.name;
    select.appendChild(option);
  }
  select.value = SHIPPED_MODEL.id;
}

/**
 * Load a candidate for a harness run. `loadEngine` requires recorded consent;
 * in a harness the developer's Run click on a chosen model is that
 * acceptance, so it is recorded here. It lands in the dev server's origin, so
 * the product at the same origin will not show its consent dialog for that
 * model until `offlinecv:webllm:consent:<id>` is removed.
 */
export function loadEvalModel(
  modelId: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<WebLlmEngine> {
  recordModelConsent(modelId);
  return loadEngine(modelId, onProgress);
}

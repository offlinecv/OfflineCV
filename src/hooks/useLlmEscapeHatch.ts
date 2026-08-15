// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useLlmEscapeHatch — drives the degenerate-case LLM recovery pass (issue #243).
 *
 * When the deterministic cascade returns a degenerate result
 * (`suggestedEscalation === "llm"` — zero experiences, low extraction ratio, or
 * similar hard failures on a text-layer PDF), this hook offers the user an opt-in
 * WebLLM pass that re-parses the resume with an on-device model and returns the
 * full `LlmParsedResume` for the caller to render in place of the heuristic parse.
 *
 * Mirrors `useResumeAnalysisLlm`'s shape (WebGPU-gated controller, `loadEngine` +
 * inference guard, `ModelLoadProgress` progress UI). The key difference: instead
 * of diffing against the heuristic parse, it returns the LLM result directly so
 * the parent can re-render the full result surface with `final_source: "llm_fallback"`.
 *
 * Availability gate: `suggestedEscalation === "llm"` AND WebGPU available AND
 * there is extractable text. Hidden (null) on everything else — silent absence.
 *
 * Pure parse logic lives in `lib/webllm/parse-resume.ts`; this hook is the
 * React/engine glue only.
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import { loadEngine, acquireInference, releaseInference } from "../lib/webllm/web-llm.ts";
import { parseResumeWithLlm, type LlmParsedResume } from "../lib/webllm/parse-resume.ts";
import { trackLlmFallbackRan } from "../lib/analytics.ts";
import { useModelSelection } from "./useModelSelection.ts";
import type { ProgressUpdate, WebGpuCapability } from "../lib/webllm/types.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

export type EscapeHatchStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running" }
  | { kind: "done"; llmParsed: LlmParsedResume }
  | { kind: "error"; message: string };

export interface EscapeHatchController {
  status: EscapeHatchStatus;
  /**
   * `false` when the escape hatch should not be shown — either because
   * `suggestedEscalation !== "llm"`, no WebGPU, or no extractable text.
   * The feature component renders nothing in that case — silent absence.
   */
  isAvailable: boolean;
  /** True while the model is loading or the parse is in flight. */
  isBusy: boolean;
  /** Start the opt-in LLM pass. No-op while already busy. */
  run: () => Promise<void>;
}

/**
 * @param result   the résumé to re-parse, edit-folded (`displayResult`).
 * @param parseKey the PRISTINE-parse identity behind `result` — see
 *                 `useAnalyzedResume.parseKey`. The reset below keys on this,
 *                 never on `result`: `result` is a memo over the edit override
 *                 maps, so it is a fresh object on every keystroke.
 */
export function useLlmEscapeHatch(
  result: CascadeResult,
  parseKey: unknown,
): EscapeHatchController {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<EscapeHatchStatus>({ kind: "idle" });
  const { selectedModelId } = useModelSelection();

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A fresh parse (new file, a library load) resets the panel — keyed on the
  // PRISTINE parse, not on `result`.
  //
  // This was `[result]`, which was harmless while the panel lived behind a tab:
  // a reset only changed a tab label. Under #823's inline layout `result` is the
  // edit-folded `displayResult`, re-memoized on every keystroke, and a reset is
  // a settled "Recovered with on-device AI" confirmation reverting to a "Try a
  // local AI pass" CTA — taking the whole "Local AI feedback" section with it
  // (`ResultDetail` withholds the quality panel while an offer stands) while the
  // header above still reads "Recovered", because THAT is keyed on `parseKey`.
  // One keystroke, and the page contradicts itself. Same distinction
  // `useLlmRecovery` and `useAnalyzedResume`'s `parseKey` docblock already make.
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [parseKey]);

  // Whether there is any text for the LLM to parse. A scanned/empty PDF has
  // none, so the recovery pass would be vacuous — treat as unavailable.
  const hasText = (result.markdown ?? result.rawText).trim().length > 0;

  const run = useCallback(async () => {
    if (status.kind === "loading" || status.kind === "running") return;
    // Snapshot the model id so the same id is released that we acquired.
    const modelId = selectedModelId;
    acquireInference(modelId);
    try {
      setStatus({ kind: "loading", progress: { progress: 0, text: "Starting…" } });
      const engine = await loadEngine(modelId, (progress) => {
        setStatus({ kind: "loading", progress });
      });
      setStatus({ kind: "running" });
      const llmParsed = await parseResumeWithLlm(
        {
          rawText: result.rawText,
          ...(result.markdown ? { markdown: result.markdown } : {}),
        },
        engine,
      );
      // Report llm_ran: true + final_source: "llm_fallback" (#243).
      trackLlmFallbackRan({ model: modelId });
      setStatus({ kind: "done", llmParsed });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't load the recovery model",
      });
    } finally {
      releaseInference(modelId);
    }
  }, [result, selectedModelId, status.kind]);

  // Only advertise when the cascade flagged this as needing LLM recovery AND
  // WebGPU is available AND there is text to parse.
  const isAvailable =
    result.suggestedEscalation === "llm" &&
    capability === "available" &&
    hasText;
  const isBusy = status.kind === "loading" || status.kind === "running";

  return { status, isAvailable, isBusy, run };
}

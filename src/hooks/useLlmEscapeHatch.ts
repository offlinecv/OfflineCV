// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

export function useLlmEscapeHatch(result: CascadeResult): EscapeHatchController {
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

  // A fresh parse (new file) resets the panel — keyed on the result identity.
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [result]);

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

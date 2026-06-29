// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useResumeCritique — drives the opt-in WebLLM content-quality critique pass
 * (issue #244).
 *
 * Mirrors `useParseDisagreement` / `useLlmEscapeHatch` in shape:
 *   - WebGPU-gated; hidden on unsupported browsers.
 *   - Shared `loadEngine` + `acquireInference`/`releaseInference` engine guard.
 *   - No network calls after the one-time model download.
 *
 * **Input:** the "active" parsed resume (`activeResult.parsed` in ParsedCard),
 * which is either the raw heuristic parse or the LLM-recovered fields merged
 * in by the #243 escape hatch. This means the critique always runs on the
 * best available parse without needing its own LLM parse pass.
 *
 * **Availability:** WebGPU available AND the resume has extractable text AND
 * at least one experience bullet OR a summary present. Hidden on scanned /
 * empty PDFs where there is nothing to judge.
 *
 * Pure engine glue only — all critique logic lives in
 * `lib/webllm/critique-resume.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import {
  loadEngine,
  acquireInference,
  releaseInference,
} from "../lib/webllm/web-llm.ts";
import {
  critiqueResumeWithLlm,
  type ResumeCritique,
} from "../lib/webllm/critique-resume.ts";
import { trackCritiqueRan } from "../lib/analytics.ts";
import { useModelSelection } from "./useModelSelection.ts";
import type { ProgressUpdate, WebGpuCapability } from "../lib/webllm/types.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";

// ── Status discriminator ──────────────────────────────────────────────────────

export type CritiqueStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running" }
  | { kind: "done"; critique: ResumeCritique }
  | { kind: "error"; message: string };

// ── Controller interface ──────────────────────────────────────────────────────

export interface CritiqueController {
  status: CritiqueStatus;
  /**
   * `false` when the feature should not be surfaced — either because WebGPU
   * is unavailable, there is no text to judge (scanned PDF), or the parsed
   * resume has neither bullets nor a summary. Silent absence, matching the
   * other WebLLM controllers.
   */
  isAvailable: boolean;
  /** True while the model is loading or the critique is in flight. */
  isBusy: boolean;
  /** Start the opt-in LLM critique pass. No-op while already busy. */
  run: () => Promise<void>;
}

// ── CTA labels ────────────────────────────────────────────────────────────────

/** CTA copy keyed off the status lifecycle (idle is the default fallback). */
const CRITIQUE_LABELS: Record<CritiqueStatus["kind"], string> = {
  idle: "Judge resume quality",
  loading: "Loading model…",
  running: "Judging content…",
  done: "Run again",
  error: "Try again",
};

/** CTA label for the run button across the status lifecycle. */
export function labelForCritique(status: CritiqueStatus): string {
  return CRITIQUE_LABELS[status.kind];
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useResumeCritique(
  parsed: HeuristicParsedResume,
  rawText: string,
): CritiqueController {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<CritiqueStatus>({ kind: "idle" });
  const { selectedModelId } = useModelSelection();

  // WebGPU probe (async, one-shot).
  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A fresh parse (new file) resets the panel.
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [parsed]);

  // Availability: something worth judging must be present.
  const hasBullets = (parsed.experience ?? []).some(
    (e) => typeof e.description === "string" && e.description.trim().length > 0,
  );
  const hasSummary =
    typeof parsed.summary === "string" && parsed.summary.trim().length > 0;
  const hasText = rawText.trim().length > 0;

  const isAvailable =
    capability === "available" && hasText && (hasBullets || hasSummary);

  const isBusy = status.kind === "loading" || status.kind === "running";

  const run = useCallback(async () => {
    if (isBusy) return;
    // Snapshot the model id so the same id is released that we acquired.
    const modelId = selectedModelId;
    acquireInference(modelId);
    try {
      setStatus({
        kind: "loading",
        progress: { progress: 0, text: "Starting…" },
      });
      const engine = await loadEngine(modelId, (progress) => {
        setStatus({ kind: "loading", progress });
      });
      setStatus({ kind: "running" });
      const critique = await critiqueResumeWithLlm(parsed, engine);
      // Anonymized telemetry — no bullet text, no PII.
      const flaggedCount = critique.bulletFindings.filter(
        (f) => f.issue !== "ok",
      ).length;
      trackCritiqueRan({
        model: modelId,
        bulletCount: critique.bulletFindings.length,
        flaggedCount,
        missingSectionCount: critique.missingSections.length,
      });
      setStatus({ kind: "done", critique });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Couldn't load the critique model",
      });
    } finally {
      releaseInference(modelId);
    }
  }, [parsed, selectedModelId, isBusy]);

  return { status, isAvailable, isBusy, run };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useResumeAnalysisLlm — the single controller driving both opt-in WebLLM
 * tabs ("What an ATS misses" #242 and "Resume quality" #244) from one
 * combined inference pass (issue #262).
 *
 * Replaces the previous `useParseDisagreement` + `useResumeCritique` pair
 * (each of which owned its own inference). One controller means:
 *   - One model load (already shared via `loadEngine`).
 *   - One inference (`analyzeResumeWithLlm`) returning both halves.
 *   - One acquire/release bracket around the call (the #148 contract).
 *   - One CTA the user clicks; both panels populate from the same status.
 *
 * The escape hatch (#243) stays a separate, degenerate-case pass (different
 * trigger + provenance) — see `useLlmEscapeHatch`.
 *
 * Telemetry is preserved: the controller still emits the existing
 * `cascade_parse_completed{llm_ran:true}`, `disagreements_found`, and
 * `llm_critique_ran` events so the funnel reads the same as before. The
 * three events still fire in a single user action because they describe
 * distinct facts (LLM ran, gaps detected, critique completed).
 *
 * Pure React/engine glue. The combined LLM logic lives in
 * `lib/webllm/analyze-resume.ts`; the diff lives in
 * `lib/heuristics/disagreement.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import {
  loadEngine,
  acquireInference,
  releaseInference,
} from "../lib/webllm/web-llm.ts";
import { analyzeResumeWithLlm } from "../lib/webllm/analyze-resume.ts";
import type { ResumeCritique } from "../lib/webllm/critique-resume.ts";
import {
  diffParses,
  type ParseDisagreement,
} from "../lib/heuristics/disagreement.ts";
import { projectLlmDiff } from "../lib/heuristics/projections.ts";
import {
  trackCritiqueRan,
  trackDisagreementsFound,
  trackLlmParseRan,
} from "../lib/analytics.ts";
import { useModelSelection } from "./useModelSelection.ts";
import type { ProgressUpdate, WebGpuCapability } from "../lib/webllm/types.ts";
import type {
  CascadeResult,
  LayoutTrigger,
} from "../lib/heuristics/types.ts";

// ── Status discriminator ──────────────────────────────────────────────────────

export interface AnalysisDone {
  /** Heuristic-vs-LLM diff (feeds the "What an ATS misses" tab). */
  disagreements: readonly ParseDisagreement[];
  /** Quality findings (feeds the "Resume quality" tab). */
  critique: ResumeCritique;
}

export type AnalysisStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running" }
  | ({ kind: "done" } & AnalysisDone)
  | { kind: "error"; message: string };

// ── Controller interface ──────────────────────────────────────────────────────

export interface AnalysisController {
  status: AnalysisStatus;
  /**
   * `false` hides the live analysis surface (no WebGPU, or no text to
   * analyze). When it's false *because* WebGPU is unavailable, the tab now
   * renders `WebGpuUnavailableNotice` instead of vanishing (#276) — the caller
   * distinguishes the two via `capability` + `hasText` below.
   */
  isAvailable: boolean;
  /**
   * WebGPU detection outcome (`null` until it resolves). Exposed so the tab can
   * tell "browser can't run on-device AI" (show the explainer) from "no résumé
   * text to analyze" (show nothing). See #276.
   */
  capability: WebGpuCapability | null;
  /** Whether there's extractable text to analyze (independent of WebGPU). */
  hasText: boolean;
  /** True while the model is loading or the inference is in flight. */
  isBusy: boolean;
  /** Start the opt-in combined analysis. No-op while already busy. */
  run: () => Promise<void>;
}

// ── CTA copy ──────────────────────────────────────────────────────────────────

const ANALYSIS_LABELS: Record<AnalysisStatus["kind"], string> = {
  idle: "Analyze with on-device model",
  loading: "Loading model…",
  running: "Analyzing…",
  done: "Analyze again",
  error: "Try again",
};

/** Label for the shared CTA across the status lifecycle. */
export function labelForAnalysis(status: AnalysisStatus): string {
  return ANALYSIS_LABELS[status.kind];
}

// ── Disagreement tally (telemetry) ────────────────────────────────────────────

interface KindTally {
  droppedRole: number;
  droppedSection: number;
  missingField: number;
  mergedRoles: number;
}

const TALLY_FIELD: Record<ParseDisagreement["kind"], keyof KindTally> = {
  dropped_role: "droppedRole",
  dropped_section: "droppedSection",
  missing_field: "missingField",
  merged_roles: "mergedRoles",
};

function tallyKinds(disagreements: readonly ParseDisagreement[]): KindTally {
  const tally: KindTally = {
    droppedRole: 0,
    droppedSection: 0,
    missingField: 0,
    mergedRoles: 0,
  };
  for (const d of disagreements) tally[TALLY_FIELD[d.kind]]++;
  return tally;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useResumeAnalysisLlm(
  result: CascadeResult,
): AnalysisController {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>({ kind: "idle" });
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

  // A fresh parse (new file) resets the panels — keyed on result identity.
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [result]);

  // Whether there is any text for the LLM to analyze. A scanned/empty PDF has
  // none, so the combined pass would be vacuous — treat as unavailable.
  const hasText = (result.markdown ?? result.rawText).trim().length > 0;

  const isBusy = status.kind === "loading" || status.kind === "running";

  const run = useCallback(async () => {
    if (isBusy) return;
    // Snapshot the model id so the same id is released that we acquired
    // (#148 contract — guards against model switch mid-inference).
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

      const combined = await analyzeResumeWithLlm(
        {
          rawText: result.rawText,
          ...(result.markdown ? { markdown: result.markdown } : {}),
        },
        engine,
      );

      // ── Telemetry: the LLM pass ran (sets llm_ran:true downstream). ──
      trackLlmParseRan({ model: modelId });

      // ── Diff the LLM parse against the heuristic parse. ──
      // Both sides are canonical shapes: the cascade canonical and the LLM
      // parse coerced through `projectLlmDiff`. `diffParses` derives its
      // whole-section-drop gate from the heuristic canonical's own section
      // headers, so the call site no longer computes `presentSections` (#445).
      const triggers = result.triggers as LayoutTrigger[];
      const disagreements = diffParses(
        result.canonical,
        projectLlmDiff(combined.parse),
        triggers,
      );
      const tally = tallyKinds(disagreements);
      trackDisagreementsFound({
        model: modelId,
        count: disagreements.length,
        triggers,
        ...tally,
      });

      // ── Critique telemetry: anonymized — no bullet text, no PII. ──
      const flaggedCount = combined.critique.bulletFindings.filter(
        (f) => f.issue !== "ok",
      ).length;
      trackCritiqueRan({
        model: modelId,
        bulletCount: combined.critique.bulletFindings.length,
        flaggedCount,
        missingSectionCount: combined.critique.missingSections.length,
      });

      setStatus({
        kind: "done",
        disagreements,
        critique: combined.critique,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Couldn't load the on-device model",
      });
    } finally {
      releaseInference(modelId);
    }
  }, [result, selectedModelId, isBusy]);

  const isAvailable = capability === "available" && hasText;

  return { status, isAvailable, capability, hasText, isBusy, run };
}

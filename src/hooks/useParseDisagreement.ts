// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useParseDisagreement — drives the opt-in WebLLM parse pass and diffs it
 * against the deterministic heuristic parse (issue #242, headline feature).
 *
 * Mirrors `useResumeRewrite`'s shape: a WebGPU-gated controller exposing a
 * status discriminator the feature component renders off. The hook owns:
 *   - WebGPU capability detection (silent absence when unavailable)
 *   - loading the selected model (shared `loadEngine` + inference guard)
 *   - running `parseResumeWithLlm` on the same rawText/markdown the cascade saw
 *   - diffing via the pure `diffParses` and surfacing `ParseDisagreement[]`
 *   - the telemetry contract: `llm_ran: true` on parse_completed + an
 *     anonymized `disagreements_found` count event, fired once per run
 *
 * Pure detection logic lives in `lib/heuristics/disagreement.ts`; this hook is
 * the React/engine glue only.
 */

import { useCallback, useEffect, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import { loadEngine, acquireInference, releaseInference } from "../lib/webllm/web-llm.ts";
import { parseResumeWithLlm } from "../lib/webllm/parse-resume.ts";
import {
  diffParses,
  type ParseDisagreement,
} from "../lib/heuristics/disagreement.ts";
import {
  trackDisagreementsFound,
  trackLlmParseRan,
} from "../lib/analytics.ts";
import { useModelSelection } from "./useModelSelection.ts";
import type { ProgressUpdate, WebGpuCapability } from "../lib/webllm/types.ts";
import type {
  CascadeResult,
  LayoutTrigger,
} from "../lib/heuristics/types.ts";

export type DisagreementStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running" }
  | { kind: "done"; disagreements: readonly ParseDisagreement[] }
  | { kind: "error"; message: string };

export interface DisagreementController {
  status: DisagreementStatus;
  /**
   * `false` hides every surface (no WebGPU, or no text to parse). The feature
   * component renders nothing in that case — silent absence, matching the
   * rewrite paths.
   */
  isAvailable: boolean;
  /** True while the model is loading or the parse is in flight. */
  isBusy: boolean;
  /** Start the opt-in LLM pass. No-op while already busy. */
  run: () => Promise<void>;
}

/** Label for the CTA across the status lifecycle. */
export function labelForDisagreement(status: DisagreementStatus): string {
  switch (status.kind) {
    case "loading":
      return "Loading model…";
    case "running":
      return "Comparing parses…";
    case "done":
      return "Compare again";
    case "error":
      return "Try again";
    default:
      return "Check what an ATS misses";
  }
}

/** Count disagreements per kind for the anonymized telemetry event. */
function tallyKinds(disagreements: readonly ParseDisagreement[]): {
  droppedRole: number;
  droppedSection: number;
  missingField: number;
  mergedRoles: number;
} {
  let droppedRole = 0;
  let droppedSection = 0;
  let missingField = 0;
  let mergedRoles = 0;
  for (const d of disagreements) {
    if (d.kind === "dropped_role") droppedRole++;
    else if (d.kind === "dropped_section") droppedSection++;
    else if (d.kind === "missing_field") missingField++;
    else if (d.kind === "merged_roles") mergedRoles++;
  }
  return { droppedRole, droppedSection, missingField, mergedRoles };
}

export function useParseDisagreement(
  result: CascadeResult,
): DisagreementController {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<DisagreementStatus>({ kind: "idle" });
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
  // none, so the comparison would be vacuous — treat as unavailable.
  const hasText = (result.markdown ?? result.rawText).trim().length > 0;

  const isBusy = status.kind === "loading" || status.kind === "running";

  const run = useCallback(async () => {
    if (isBusy) return;
    // Snapshot the model id so the same id is released that we acquired.
    const modelId = selectedModelId;
    acquireInference(modelId);
    try {
      setStatus({ kind: "loading", progress: { progress: 0, text: "Starting…" } });
      const engine = await loadEngine(modelId, (progress) => {
        setStatus({ kind: "loading", progress });
      });
      setStatus({ kind: "running" });
      const llm = await parseResumeWithLlm(
        { rawText: result.rawText, ...(result.markdown ? { markdown: result.markdown } : {}) },
        engine,
      );
      // The LLM pass ran — stamp the funnel (sets llm_ran:true downstream).
      trackLlmParseRan({ model: modelId });

      const triggers = result.triggers as LayoutTrigger[];
      const disagreements = diffParses(result.parsed, llm, triggers);
      const tally = tallyKinds(disagreements);
      trackDisagreementsFound({
        model: modelId,
        count: disagreements.length,
        triggers,
        ...tally,
      });
      setStatus({ kind: "done", disagreements });
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't load the comparison model",
      });
    } finally {
      releaseInference(modelId);
    }
  }, [result, selectedModelId, isBusy]);

  const isAvailable = capability === "available" && hasText;

  return { status, isAvailable, isBusy, run };
}

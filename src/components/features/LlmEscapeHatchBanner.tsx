// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * LlmEscapeHatchBanner — the degenerate-case recovery CTA (issue #243).
 *
 * Shown above the result tabs when the cascade returned a degenerate parse
 * (`suggestedEscalation === "llm"`) and WebGPU is available. Offers the user
 * an opt-in on-device LLM re-parse and renders the download progress while it
 * runs.
 *
 * When the LLM pass completes, calls `onRecovered(llmParsed)` so the parent
 * (`ParsedCard` in `Result.tsx`) can substitute the LLM-parsed fields into the
 * result surface and show the "recovered with on-device AI" provenance badge.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` (the opt-in CTA) — no raw `<button>`.
 *   - Shared: `ModelLoadProgress` (download bar, same as DisagreementPanel #242
 *     and SectionRewrite) — no parallel progress component.
 *   - Semantic tokens only; no hardcoded hex or raw palette classes.
 *
 * Returns `null` when the controller flags the feature unavailable. Silent
 * absence — matches the rewrite and disagreement paths.
 */

import { Button, ModelLoadProgress } from "@design-system";
import type { EscapeHatchController, EscapeHatchStatus } from "../../hooks/useLlmEscapeHatch.ts";
import type { LlmParsedResume } from "../../lib/webllm/parse-resume.ts";
import { useEffect, useRef } from "react";

/** CTA copy keyed off the status lifecycle (idle is the default fallback). */
const CTA_LABELS: Record<EscapeHatchStatus["kind"], string> = {
  idle: "Try a local AI pass",
  loading: "Loading model…",
  running: "Parsing with on-device AI…",
  done: "Re-run AI recovery",
  error: "Try again",
};

function ctaLabel(status: EscapeHatchStatus): string {
  return CTA_LABELS[status.kind];
}

interface LlmEscapeHatchBannerProps {
  controller: EscapeHatchController;
  /** Called with the LLM-parsed result once the pass completes. */
  onRecovered: (llmParsed: LlmParsedResume) => void;
}

/**
 * The banner is only mounted when `controller.isAvailable` (the parent gates
 * on this), so no internal availability guard is needed.
 */
export function LlmEscapeHatchBanner({
  controller,
  onRecovered,
}: LlmEscapeHatchBannerProps) {
  const { status } = controller;

  // Notify parent once per done-transition. The ref guard makes this one-shot:
  // it fires the moment status enters `done` and resets when status leaves
  // `done`, so a future inlined (non-memoized) `onRecovered` can't re-fire it on
  // every render. Behavior is identical for the current useCallback([]) caller.
  const notifiedDone = useRef(false);
  useEffect(() => {
    if (status.kind === "done") {
      if (!notifiedDone.current) {
        notifiedDone.current = true;
        onRecovered(status.llmParsed);
      }
    } else {
      notifiedDone.current = false;
    }
  }, [status, onRecovered]);

  return (
    <div
      role="region"
      aria-label="AI recovery suggestion"
      className="flex flex-col gap-2 rounded-lg border border-feedback-info-border bg-feedback-info-bg px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-content-primary">
            We couldn't read much of this resume.
          </p>
          <p className="text-xs text-content-tertiary">
            Try a local AI pass? Runs entirely in your browser — nothing leaves
            this tab. One-time ~1.2&nbsp;GB download, cached for next time.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void controller.run()}
          disabled={controller.isBusy}
          aria-label="Run an on-device AI pass to recover the resume parse"
        >
          {ctaLabel(status)}
        </Button>
      </div>

      {status.kind === "loading" && (
        <ModelLoadProgress
          progress={status.progress.progress}
          text={status.progress.text}
          label="Loading the recovery model (one-time download)"
          showExplainer
        />
      )}

      {status.kind === "running" && (
        <p className="text-xs text-content-secondary" role="status">
          Parsing with on-device AI…
        </p>
      )}

      {status.kind === "error" && (
        <p role="alert" className="text-xs text-feedback-error-text">
          {status.message}
        </p>
      )}

      {status.kind === "done" && (
        <p className="text-xs text-feedback-success-text">
          Recovered with on-device AI — result updated below.
        </p>
      )}
    </div>
  );
}

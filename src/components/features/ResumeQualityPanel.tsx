// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ResumeQualityPanel — consolidated "Resume Quality" tab shell (issue #273).
 *
 * Replaces the two separate "What an ATS misses" (DisagreementPanel) and
 * "Resume quality" (CritiquePanel) tabs with a single tab driven by one
 * `AnalysisController`. Owns the SINGLE header + description + one Analyze
 * CTA + status lifecycle (loading → running → done / error).
 *
 * On done, renders top→bottom:
 *   1. CritiqueResults — bullet quality, missing sections, summary feedback.
 *   2. "What an ATS misses" bottom section (only when gaps > 0):
 *      heading + intro + DisagreementResults + ReportGapSection.
 *
 * Tab order in Result.tsx: reconstructed → Resume Quality → Source & diagnostics.
 *
 * Design rules (CLAUDE.md):
 *   - Semantic tokens only; no hardcoded hex or raw palette classes.
 *   - All interactive elements via <Button> from "@design-system".
 *   - No raw <button> in this file.
 */

import { Button, ModelLoadProgress } from "@design-system";
import {
  labelForAnalysis,
  type AnalysisController,
} from "../../hooks/useResumeAnalysisLlm.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { CritiqueResults } from "./CritiquePanel.tsx";
import { DisagreementResults } from "./DisagreementPanel.tsx";
import { ReportGapSection } from "./ReportGapSection.tsx";

// ── Public component ──────────────────────────────────────────────────────────

export function ResumeQualityPanel({
  controller,
  result,
  onGoToRewrite,
}: {
  controller: AnalysisController;
  result: CascadeResult;
  /** Navigate to the "Reconstructed resume" tab so the user can use the wand. */
  onGoToRewrite: () => void;
}) {
  const { status } = controller;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Resume Quality
          </h2>
          <p className="max-w-prose text-sm text-content-tertiary">
            Run a small on-device model to judge bullet quality — weak verbs,
            missing metrics, vague language — and flag absent sections. Also
            compares what a generic ATS extractor reads against what's on
            the page. Nothing leaves this tab.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void controller.run()}
          disabled={controller.isBusy}
          aria-label="Analyze the resume with an on-device model"
        >
          {labelForAnalysis(status)}
        </Button>
      </div>

      {status.kind === "loading" && (
        <ModelLoadProgress
          progress={status.progress.progress}
          text={status.progress.text}
          label="Loading the on-device model (one-time download)"
          showExplainer
        />
      )}

      {status.kind === "running" && (
        <p className="text-sm text-content-secondary" role="status">
          Analyzing…
        </p>
      )}

      {status.kind === "error" && (
        <p role="alert" className="text-sm text-feedback-error-text">
          {status.message}
        </p>
      )}

      {status.kind === "done" && (
        <div className="flex flex-col gap-6">
          <CritiqueResults
            critique={status.critique}
            onGoToRewrite={onGoToRewrite}
          />

          {status.disagreements.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
                What an ATS misses
              </h3>
              <p className="text-sm text-content-secondary">
                Each card below is something the on-device model found on your
                résumé that a generic ATS extractor missed — so an applicant
                tracking system may never index it. These are gaps in your
                favor to be aware of, not errors.
              </p>
              <DisagreementResults disagreements={status.disagreements} />
              <ReportGapSection
                result={result}
                disagreements={status.disagreements}
              />
            </section>
          )}
        </div>
      )}
    </section>
  );
}

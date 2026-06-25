// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Whole-résumé "Rewrite full résumé" feature (issue #67 — Phase 4 of #66).
 *
 * This file owns:
 *   - The single primary CTA (mounted next to the model picker at the
 *     top of the Experience section)
 *   - The status-to-UI routing (loading → running → proposed → error)
 *   - The in-flight `StepIndicator` + `CompletedList`
 *
 * The proposed-state UI (before/after panels, aggregated drift warning,
 * discard CTA) lives in the sibling `ResumeRewriteProposed.tsx` so this
 * file stays under CLAUDE.md's ~200 LOC soft cap.
 *
 * Coexists with the per-role `SectionRewrite` buttons (still rendered on
 * each `RoleEntry`) — the same `useSectionRewriteLock` makes the two paths
 * mutually exclusive.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` from `@design-system` for the CTA. No raw
 *     `<button>` in this file.
 *   - Shared: `ModelLoadProgress` for the engine-download bar.
 *
 * Returns `null` for `trigger` and `panel` when the controller flags the
 * feature unavailable (no WebGPU, or no rewriteable section in the parsed
 * résumé). Silent absence — matches `RewriteButton` and `SectionRewrite`.
 */

import { Button, ModelLoadProgress } from "@design-system";
import {
  labelForResumeRewrite,
  useResumeRewrite,
  type ResumeRewriteStatus,
} from "../../hooks/useResumeRewrite.ts";
import type { SectionInput, SectionOutcome } from "../../lib/webllm/rewrite-resume.ts";
import { ProposedPanel } from "./ResumeRewriteProposed.tsx";

export interface ResumeRewriteParts {
  trigger: React.ReactNode;
  panel: React.ReactNode;
}

export function useResumeRewriteUi(
  sections: readonly SectionInput[],
): ResumeRewriteParts {
  const controller = useResumeRewrite(sections);

  if (!controller.isAvailable) {
    return { trigger: null, panel: null };
  }

  const trigger = (
    <Button
      variant="primary"
      size="sm"
      onClick={() => {
        void controller.start();
      }}
      disabled={controller.isLocked}
      aria-label="Rewrite every section of the résumé"
    >
      {labelForResumeRewrite(controller.status, controller.isLockedByOther)}
    </Button>
  );

  const panel =
    controller.status.kind === "idle" ? null : (
      <ResumeRewritePanel status={controller.status} onDismiss={controller.dismiss} />
    );

  return { trigger, panel };
}

export function ResumeRewritePanel({
  status,
  onDismiss,
}: {
  status: ResumeRewriteStatus;
  onDismiss: () => void;
}) {
  if (status.kind === "idle") return null;
  if (status.kind === "loading") {
    return (
      <ModelLoadProgress
        progress={status.progress.progress}
        text={status.progress.text}
        label="Loading the rewrite model (one-time download)"
      />
    );
  }
  if (status.kind === "error") {
    return (
      <p role="alert" className="text-xs text-feedback-error-text">
        {status.message}
      </p>
    );
  }
  if (status.kind === "running") {
    // `currentLabel` is null only on the final completion event, which
    // transitions to "proposed" before any UI sees it — but fall through to
    // "Finishing…" for safety so the indicator never flashes empty.
    const label = status.progress.currentLabel ?? "Finishing…";
    return (
      <div className="flex flex-col gap-3 rounded border border-border-light bg-surface-subtle p-3">
        <StepIndicator
          currentIndex={status.progress.currentIndex}
          totalSections={status.progress.totalSections}
          label={label}
        />
        {status.progress.completed.length > 0 && (
          <CompletedList outcomes={status.progress.completed} />
        )}
      </div>
    );
  }
  return <ProposedPanel result={status.result} onDismiss={onDismiss} />;
}

export function StepIndicator({
  currentIndex,
  totalSections,
  label,
}: {
  currentIndex: number;
  totalSections: number;
  label: string;
}) {
  const done = Math.min(currentIndex, totalSections);
  const pct = totalSections > 0 ? Math.round((done / totalSections) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-content-secondary">
        <span>
          Rewriting {Math.min(currentIndex + 1, totalSections)} of {totalSections}: {label}
        </span>
        <span className="font-mono text-[11px]">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Whole-résumé rewrite progress"
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-base"
      >
        <div
          className="h-full bg-brand-amber transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CompletedList({
  outcomes,
}: {
  outcomes: readonly SectionOutcome[];
}) {
  return (
    <ul className="flex flex-col gap-1 list-none text-xs text-content-secondary">
      {outcomes.map((outcome, i) => (
        <li key={`${outcome.kind}-${i}`} className="flex items-center gap-2">
          <span aria-hidden="true" className="text-content-muted">
            ✓
          </span>
          <span>{outcome.input.label}</span>
          {!outcome.data.numbersPreserved && (
            <span
              className="rounded bg-feedback-warning-bg px-1.5 py-0.5 text-[10px] text-feedback-warning-text"
              title="A metric was altered or removed"
            >
              metric drift
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

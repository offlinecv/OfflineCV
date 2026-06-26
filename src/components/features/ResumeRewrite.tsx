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

import { Button, ModelLoadProgress, TextAreaField } from "@design-system";
import {
  labelForResumeRewrite,
  useResumeRewrite,
  type ResumeRewriteController,
  type ResumeRewriteStatus,
} from "../../hooks/useResumeRewrite.ts";
import type { SectionInput, SectionOutcome } from "../../lib/webllm/rewrite-resume.ts";
import type { PageTarget } from "../../lib/webllm/steering.ts";
import { ProposedPanel } from "./ResumeRewriteProposed.tsx";

export interface ResumeRewriteParts {
  trigger: React.ReactNode;
  /** The steering box (freeform instructions + page-length chips), #210. */
  controls: React.ReactNode;
  panel: React.ReactNode;
}

/**
 * Page-length presets (#210). Selecting a chip sets the controller's
 * `pageTarget` (which drives the precise length budget injected into the
 * prompt) and — only when the box is empty — prefills a short, editable
 * human-readable hint so the user sees what was applied. The label drives the
 * chip; the `hint` is what lands in the freeform box.
 */
const PAGE_PRESETS: { target: PageTarget; label: string; hint: string }[] = [
  { target: 1, label: "1 page", hint: "Trim this résumé to a single page." },
  { target: 2, label: "2 pages", hint: "Keep this résumé to about two pages." },
  { target: 3, label: "3 pages", hint: "Allow up to three pages of detail." },
];

export function useResumeRewriteUi(
  sections: readonly SectionInput[],
): ResumeRewriteParts {
  const controller = useResumeRewrite(sections);

  if (!controller.isAvailable) {
    return { trigger: null, controls: null, panel: null };
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

  const controls = <RewriteSteeringBox controller={controller} />;

  const panel =
    controller.status.kind === "idle" ? null : (
      <ResumeRewritePanel status={controller.status} onDismiss={controller.dismiss} />
    );

  return { trigger, controls, panel };
}

/**
 * Freeform "Instructions for the rewrite" box with page-length preset chips
 * (#210). One input: the chips prefill editable guidance into the same box and
 * set the page-length target. Inputs disable while any rewrite is in flight so
 * the user can't change steering mid-run. Reuses the `TextAreaField` and
 * `Button` primitives — no raw `<textarea>` / `<button>`.
 */
function RewriteSteeringBox({
  controller,
}: {
  controller: ResumeRewriteController;
}) {
  const { pageTarget, setPageTarget, userInstructions, setUserInstructions } =
    controller;
  const disabled = controller.isLocked;

  const onChipClick = (preset: (typeof PAGE_PRESETS)[number]) => {
    if (pageTarget === preset.target) {
      // Toggle off. Clear the prefilled hint too, but never clobber text the
      // user has since edited away from the preset's hint.
      setPageTarget(null);
      if (userInstructions.trim() === preset.hint) setUserInstructions("");
      return;
    }
    setPageTarget(preset.target);
    // Prefill only when the box is empty — don't overwrite custom text.
    if (userInstructions.trim().length === 0) setUserInstructions(preset.hint);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-content-secondary">
          Target length:
        </span>
        {PAGE_PRESETS.map((preset) => {
          const selected = pageTarget === preset.target;
          return (
            <Button
              key={preset.target}
              variant={selected ? "primary" : "ghost"}
              size="sm"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChipClick(preset)}
              className="rounded-full border border-border-light px-2.5 py-0.5 text-[11px]"
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
      <TextAreaField
        label="Instructions for the rewrite (optional)"
        value={userInstructions}
        onChange={setUserInstructions}
        placeholder="e.g. 'target a staff engineer role' or 'keep bullets under 20 words'"
        disabled={disabled}
      />
    </div>
  );
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

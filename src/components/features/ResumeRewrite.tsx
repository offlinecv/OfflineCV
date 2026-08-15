// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Whole-résumé "Rewrite full résumé" feature (issue #67 — Phase 4 of #66).
 *
 * This file owns:
 *   - The single primary CTA (mounted next to the model picker at the
 *     top of the Experience section), which opens a steering dialog
 *   - The steering dialog (#210 page-length chips + instructions), shown
 *     before the run; "Run rewrite" starts it and closes the dialog. Its
 *     collapsed "copy the prompt instead" disclosure (#609) lives in the
 *     sibling `RewritePromptDisclosure.tsx`
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

import { useState } from "react";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";
import { Button, Checkbox, Dialog, InlineResult, ModelLoadProgress, TextAreaField } from "@design-system";
import {
  labelForResumeRewrite,
  useResumeRewrite,
  type ResumeRewriteController,
  type ResumeRewriteStatus,
} from "../../hooks/useResumeRewrite.ts";
import type { SectionInput, SectionOutcome } from "../../lib/webllm/rewrite-resume.ts";
import type { PageTarget } from "../../lib/webllm/steering.ts";
import {
  ApplyConfirmation,
  UndoBatchButton,
  UNDO_HOLD_MS,
} from "./ApplyConfirmation.tsx";
import {
  ProposedPanel,
  type ResumeRewriteApply,
} from "./ResumeRewriteProposed.tsx";
import { RewritePromptDisclosure } from "./RewritePromptDisclosure.tsx";

export interface ResumeRewriteParts {
  /** The CTA button; opens the steering dialog (#210 steering box now lives
   *  inside that dialog, not inline). */
  trigger: React.ReactNode;
  panel: React.ReactNode;
}

/**
 * Page-length presets (#210). Selecting a chip sets the controller's
 * `pageTarget` (which drives the precise length budget injected into the
 * prompt) and — only when the box is empty — prefills a short, editable
 * human-readable hint so the user sees what was applied. The label drives the
 * chip; the `hint` is what lands in the freeform box.
 */
const PAGE_PRESETS: { target: PageTarget | null; label: string; hint: string }[] = [
  { target: null, label: "No limit", hint: "" },
  { target: 1, label: "1 page", hint: "Trim this résumé to a single page." },
  { target: 2, label: "2 pages", hint: "Keep this résumé to about two pages." },
  { target: 3, label: "3 pages", hint: "Allow up to three pages of detail." },
];

/** A page-length hint string the chips prefill, used to tell a chip-prefilled
 *  box from one the user typed (so "No limit" / toggle-off can clear it). */
const PRESET_HINTS = new Set(PAGE_PRESETS.map((p) => p.hint).filter(Boolean));

export function useResumeRewriteUi(
  sections: readonly SectionInput[],
  applyBySection?: ResumeRewriteApply,
  /** Optional JD-driven rewrite steering (#226). Undefined on `/` → generic. */
  jdContext?: string,
  /**
   * The on-device critique of this résumé, when one has been run (#608). Its
   * per-bullet findings steer the rewrite so the app acts on the feedback it
   * already showed the user. Undefined → byte-identical pre-#608 prompt.
   */
  critique?: ResumeCritique,
  /** A whole-résumé rewrite was applied (#826) — forwarded to the controller,
   *  whose `confirmApplied` is the transition. See `useResumeRewrite`. */
  onRewriteApplied?: () => void,
): ResumeRewriteParts {
  const controller = useResumeRewrite(
    sections,
    jdContext,
    critique,
    onRewriteApplied,
  );

  if (!controller.isAvailable) {
    return { trigger: null, panel: null };
  }

  const trigger = <RewriteLauncher controller={controller} />;

  const panel =
    controller.status.kind === "idle" ? null : (
      <ResumeRewritePanel
        status={controller.status}
        onDismiss={controller.dismiss}
        onApplied={controller.confirmApplied}
        onUndo={controller.undoApplied}
        applyBySection={applyBySection}
      />
    );

  return { trigger, panel };
}

/**
 * The CTA button + its steering dialog. Clicking the button opens a modal that
 * collects the rewrite options (page-length chips + freeform instructions);
 * "Run rewrite" starts the rewrite and closes the dialog — progress then renders
 * inline via {@link ResumeRewritePanel} (option (a): dialog is options-only, it
 * doesn't host the run). Disabled while a rewrite is locked/in flight.
 */
function RewriteLauncher({
  controller,
}: {
  controller: ResumeRewriteController;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={controller.isLocked}
        aria-label="Rewrite every section of the résumé"
      >
        {labelForResumeRewrite(controller.status, controller.isLockedByOther)}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rewrite full résumé"
        className="w-[min(28rem,90vw)]"
      >
        <div className="flex flex-col gap-4">
          <RewriteSteeringBox controller={controller} />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void controller.start();
                setOpen(false);
              }}
            >
              Run rewrite
            </Button>
          </div>
          {/* #609 — the secondary path, BELOW the primary CTA and collapsed.
              The on-device pass stays the one-click answer; this only reveals
              the prompt behind it for a user who would rather run it somewhere
              stronger. It reads the same `controller`, so what it shows is the
              steering this dialog is currently expressing. */}
          <RewritePromptDisclosure controller={controller} />
        </div>
      </Dialog>
    </>
  );
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
  const {
    pageTarget,
    setPageTarget,
    userInstructions,
    setUserInstructions,
    hasFindings,
    useFindings,
    setUseFindings,
  } = controller;
  const disabled = controller.isLocked;

  const onChipClick = (preset: (typeof PAGE_PRESETS)[number]) => {
    // "No limit" (target null): clear the page target and drop any
    // chip-prefilled hint, but never clobber text the user typed themselves.
    if (preset.target === null) {
      setPageTarget(null);
      if (PRESET_HINTS.has(userInstructions.trim())) setUserInstructions("");
      return;
    }
    if (pageTarget === preset.target) {
      // Toggle off. Clear the prefilled hint too, but never clobber text the
      // user has since edited away from the preset's hint.
      setPageTarget(null);
      if (userInstructions.trim() === preset.hint) setUserInstructions("");
      return;
    }
    setPageTarget(preset.target);
    // Prefill when the box is empty OR still holds another preset's hint — so
    // switching 1→2 pages refreshes the visible copy instead of leaving a stale
    // "single page" line. Never clobber text we don't recognize as a preset hint.
    const current = userInstructions.trim();
    if (current.length === 0 || PRESET_HINTS.has(current)) {
      setUserInstructions(preset.hint);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs font-medium text-content-secondary">
          Target length:
        </span>
        {PAGE_PRESETS.map((preset) => {
          const selected = pageTarget === preset.target;
          return (
            <Button
              key={preset.label}
              variant={selected ? "primary" : "ghost"}
              size="sm"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChipClick(preset)}
              className="rounded-full border border-border-light px-2.5 py-0.5 text-2xs"
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
      {hasFindings && (
        <Checkbox
          checked={useFindings}
          onChange={setUseFindings}
          disabled={disabled}
          label="Use the quality findings from the critique"
          hint="Each flagged line is rewritten with its own note attached."
        />
      )}
      <TextAreaField
        label="Instructions for the rewrite (optional)"
        value={userInstructions}
        onChange={setUserInstructions}
        placeholder="e.g. 'lead with impact, not responsibilities' or 'keep bullets under 20 words'"
        disabled={disabled}
      />
      {/* #608 Phase 3 — the global/per-section mismatch, stated instead of
          silently disappointing. The rewriter runs section by section and the
          model never sees the whole résumé, so a whole-document instruction
          ("cut this to one page") is asking for something the architecture
          cannot do — `pageTarget` is explicitly an approximation, not
          pagination (steering.ts). Say which instructions actually work rather
          than letting the user discover it from a rewrite that ignored them.
          Decomposing an instruction per section is the real fix and is out of
          scope for #608. */}
      <p className="text-2xs text-content-muted">
        Applied to one section at a time, so per-bullet guidance (tone, verbs,
        length, what to emphasise) works best. Use the length chips above for
        whole-résumé sizing.
      </p>
    </div>
  );
}

export function ResumeRewritePanel({
  status,
  onDismiss,
  onApplied,
  onUndo,
  applyBySection,
}: {
  status: ResumeRewriteStatus;
  onDismiss: () => void;
  onApplied: (
    count: number,
    sections: readonly string[],
    undo?: () => void,
  ) => void;
  /** Reverse the applied batch (issue 510). */
  onUndo: () => void;
  applyBySection?: ResumeRewriteApply;
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
      <p role="alert" className="text-sm text-feedback-error-text">
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
  if (status.kind === "applied") {
    return (
      <InlineResult tone="success">
        <ApplyConfirmation
          count={status.count}
          sections={status.sections}
          onCollapse={onDismiss}
          // Only a confirmation that actually hosts an Undo gets the longer
          // hold — with no undo this stays on #508's 3s.
          holdMs={status.undo ? UNDO_HOLD_MS : undefined}
          action={status.undo && <UndoBatchButton onUndo={onUndo} />}
        />
      </InlineResult>
    );
  }
  if (status.kind === "undone") {
    return (
      <InlineResult tone="success">
        <ApplyConfirmation
          verb="Reverted"
          count={status.count}
          sections={status.sections}
          onCollapse={onDismiss}
        />
      </InlineResult>
    );
  }
  return (
    <ProposedPanel
      result={status.result}
      onDismiss={onDismiss}
      onApplied={onApplied}
      applyBySection={applyBySection}
    />
  );
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
      <div className="flex items-center justify-between text-sm text-content-secondary">
        <span>
          Rewriting {Math.min(currentIndex + 1, totalSections)} of {totalSections}: {label}
        </span>
        <span className="font-mono text-2xs">{pct}%</span>
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
          className="h-full bg-accent-primary transition-all"
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
    <ul className="flex flex-col gap-1 list-none text-sm text-content-secondary">
      {outcomes.map((outcome, i) => (
        <li key={`${outcome.kind}-${i}`} className="flex items-center gap-2">
          <span aria-hidden="true" className="text-content-muted">
            ✓
          </span>
          <span>{outcome.input.label}</span>
          {!outcome.data.numbersPreserved && (
            <span
              className="rounded bg-feedback-warning-bg px-1.5 py-0.5 text-3xs text-feedback-warning-text"
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

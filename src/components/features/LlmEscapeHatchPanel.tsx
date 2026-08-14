// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * LlmEscapeHatchPanel — the degenerate-case recovery offer (issue #243).
 *
 * Was `LlmEscapeHatchBanner`: a tinted, bordered banner rendered ABOVE the
 * score card, so the first thing on the post-drop screen was our suggestion
 * rather than the user's own result. #243 moved it into the on-device-AI tab,
 * whose label carried the offer; #823 took that tab rail away, so it renders
 * as its own card BELOW the score card and above the résumé (`ResultDetail`).
 * Still not first, and still not behind anything — a collapsed section would
 * hide the one affordance that repairs a degenerate parse from exactly the
 * parses that need it.
 *
 * While the offer stands it is alone: `ResumeQualityPanel` is withheld until
 * the pass has run. Showing both put two model-loading CTAs on one screen, one
 * of them still wrapped in banner chrome that belonged to the old placement
 * (user testing, Jul 2026).
 *
 * So the shape here is deliberately `ResumeQualityPanel`'s, not a banner's:
 * same `section` + heading + `max-w-prose` explainer + right-aligned primary
 * Button. A user switching between the two states should see one surface
 * change its offer, not two differently-dressed widgets.
 *
 * When the LLM pass completes, calls `onRecovered(llmParsed)` so the owner
 * (`App`, via `useLlmRecovery`) can substitute the LLM-parsed fields into the
 * result surface, show the "recovered with on-device AI" provenance badge, and
 * hand the recovered parse — not the broken one — to `/jobs/` and the export.
 * The panel stays mounted through `done` — that transition is what fires the
 * callback, so a `status.kind !== "done"` mount gate in the parent would swap
 * the panel out in the same render that produces the result and the callback
 * would never fire. It collapses to a single confirmation row instead.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule):
 *   - Primitive: `Button` (the opt-in CTA) — no raw `<button>`.
 *   - Shared: `ModelLoadProgress` (download bar, same as DisagreementPanel #242
 *     and SectionRewrite) — no parallel progress component.
 *   - Semantic tokens only; no hardcoded hex or raw palette classes.
 *
 * Rendered only when the controller flags the feature available — the caller
 * gates on `escapeHatch.isAvailable`, so there is no internal guard.
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

interface LlmEscapeHatchPanelProps {
  controller: EscapeHatchController;
  /** Called with the LLM-parsed result once the pass completes. */
  onRecovered: (llmParsed: LlmParsedResume) => void;
}

export function LlmEscapeHatchPanel({
  controller,
  onRecovered,
}: LlmEscapeHatchPanelProps) {
  const { status } = controller;

  // Notify parent once per done-transition. The ref guard makes this one-shot:
  // it fires the moment status enters `done` and resets when status leaves
  // `done`, so a future inlined (non-memoized) `onRecovered` can't re-fire it on
  // every render. The current caller is `useLlmRecovery`'s
  // `useCallback(…, [parseKey])` — stable for the life of a parse, so the guard
  // changes nothing today; it is what keeps a less stable callback from
  // re-reporting the same recovered parse on every render.
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

  // Post-recovery this collapses to one quiet row: the offer has been taken,
  // the quality panel renders directly below it, and re-running is a rare
  // repair action — a `link` Button, not a second primary CTA competing with
  // the one in that panel.
  if (status.kind === "done") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <p className="text-sm text-feedback-success-text">
          Recovered with on-device AI — your score and fields are updated.
        </p>
        <Button
          variant="link"
          size="sm"
          onClick={() => void controller.run()}
          disabled={controller.isBusy}
          aria-label="Run the on-device AI recovery pass again"
        >
          {ctaLabel(status)}
        </Button>
      </div>
    );
  }

  return (
    <section aria-label="AI recovery suggestion" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          {/*
            Headline copy must stay honest across every firing path in
            `chooseEscalation` (confidence.ts): hard failures (missing email,
            low extraction ratio, etc.) AND soft confidence dips below the
            canonical threshold. An earlier "We couldn't read much of this
            resume" wording overstated the failure on the soft path — resumes
            where the parser recovered most fields but confidence sat just
            below 0.85 (e.g. missing dates on some roles) got a headline that
            claimed the parser had failed. Speak to the parse quality
            neutrally: "not everything parsed cleanly" is true across all
            paths without misattributing content-quality issues to a parser
            failure.

            Heading level and treatment match `ResumeQualityPanel`'s, since
            the two alternate in the same tab body.
          */}
          <h2 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
            Not everything parsed cleanly
          </h2>
          <p className="max-w-prose text-sm text-content-tertiary">
            A small model running in this tab can re-read your file and rebuild
            the fields the parser got wrong. Runs entirely in your browser —
            nothing leaves this tab. One-time ~1.2&nbsp;GB download, cached for
            next time.
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
        <p className="text-sm text-content-secondary" role="status">
          Parsing with on-device AI…
        </p>
      )}

      {status.kind === "error" && (
        <p role="alert" className="text-sm text-feedback-error-text">
          {status.message}
        </p>
      )}
    </section>
  );
}

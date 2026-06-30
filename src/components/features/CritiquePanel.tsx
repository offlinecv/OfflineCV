// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * CritiquePanel — the "Resume quality" tab panel (issue #244).
 *
 * Shows the results of the on-device LLM content-quality critique, one row
 * per flagged bullet and a list of missing sections. As of #262 the critique
 * is one half of a single combined inference (the other half feeds the
 * "What an ATS misses" tab) — this panel is display-only and reads its slice
 * from the shared `AnalysisController`.
 *
 * Bullet finding rows include a "Suggest a rewrite" nudge that navigates the
 * user to the "Reconstructed resume" tab, where the per-role wand button
 * (useSectionRewrite) already lives. This ties the critique finding to the
 * existing affordance (#3) without duplicating any rewrite UI here.
 *
 * Design rules (CLAUDE.md):
 *   - Semantic tokens only; no hardcoded hex or raw palette classes.
 *   - All interactive elements via <Button> from "@design-system".
 *   - No raw <button> in this file.
 */

import { Button, Card, ModelLoadProgress, StatusBadge } from "@design-system";
import type { BulletFinding, ResumeCritique } from "../../lib/webllm/critique-resume.ts";
import {
  labelForAnalysis,
  type AnalysisController,
} from "../../hooks/useResumeAnalysisLlm.ts";

// ── Issue labels ──────────────────────────────────────────────────────────────

const ISSUE_LABEL: Record<BulletFinding["issue"], string> = {
  no_quantification: "No metric",
  weak_verb: "Weak verb",
  vague: "Vague",
  ok: "OK",
};

const ISSUE_TONE: Record<BulletFinding["issue"], "warning" | "ok" | "info"> = {
  no_quantification: "warning",
  weak_verb: "warning",
  vague: "warning",
  ok: "ok",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function BulletFindingRow({
  finding,
  onGoToRewrite,
}: {
  finding: BulletFinding;
  /** Switch to the "Reconstructed resume" tab where the rewrite affordance lives. */
  onGoToRewrite?: () => void;
}) {
  const { issue, bullet, suggestion } = finding;
  const isFlagged = issue !== "ok";

  if (!isFlagged) return null;

  return (
    <li className="flex flex-col gap-1.5 rounded border border-border-light bg-surface-subtle p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <StatusBadge tone={ISSUE_TONE[issue]}>{ISSUE_LABEL[issue]}</StatusBadge>
          <p className="text-sm text-content-secondary leading-snug">
            {bullet}
          </p>
        </div>
      </div>
      {suggestion && (
        <p className="text-xs text-content-tertiary">
          <span className="font-medium text-content-secondary">Suggestion: </span>
          {suggestion}
        </p>
      )}
      {onGoToRewrite && (
        <Button
          variant="link"
          size="sm"
          onClick={onGoToRewrite}
          className="self-start text-[11px] font-medium text-brand-amber"
          aria-label="Go to Reconstructed resume tab to rewrite this bullet"
        >
          Rewrite this section →
        </Button>
      )}
    </li>
  );
}

function MissingSectionRow({ section }: { section: string }) {
  return (
    <li className="flex items-center gap-2 rounded border border-border-light bg-surface-subtle p-3">
      <StatusBadge tone="warning">Missing</StatusBadge>
      <span className="text-sm text-content-secondary capitalize">{section}</span>
    </li>
  );
}

function CritiqueDonePanel({
  critique,
  onGoToRewrite,
}: {
  critique: ResumeCritique;
  onGoToRewrite: () => void;
}) {
  const flaggedBullets = critique.bulletFindings.filter((f) => f.issue !== "ok");
  const allOk =
    flaggedBullets.length === 0 && critique.missingSections.length === 0;

  if (allOk) {
    return (
      <p className="text-sm text-content-secondary">
        All bullets look strong — strong verbs, metrics present, and no missing
        sections detected.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {critique.summaryFeedback && (
        <Card className="flex flex-col gap-1 p-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
            Summary
          </span>
          <p className="text-sm text-content-secondary">{critique.summaryFeedback}</p>
        </Card>
      )}

      {flaggedBullets.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Bullet findings ({flaggedBullets.length} flagged)
          </h3>
          <ul className="flex flex-col gap-2 list-none">
            {flaggedBullets.map((f, i) => (
              <BulletFindingRow
                key={`${f.issue}-${i}`}
                finding={f}
                onGoToRewrite={onGoToRewrite}
              />
            ))}
          </ul>
        </div>
      )}

      {critique.missingSections.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Possibly missing sections
          </h3>
          <ul className="flex flex-col gap-2 list-none">
            {critique.missingSections.map((s) => (
              <MissingSectionRow key={s} section={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

/**
 * The full critique tab panel. The controller is owned by `ParsedCard` (lifted
 * so the tab label can be gated on availability), and the parent only mounts
 * this when `controller.isAvailable`.
 *
 * `onGoToRewrite` is a callback that switches the parent's tab state to
 * "reconstructed", where the existing per-role rewrite wand button lives.
 */
export function CritiquePanel({
  controller,
  onGoToRewrite,
}: {
  controller: AnalysisController;
  /** Navigate to the "Reconstructed resume" tab so the user can use the wand. */
  onGoToRewrite: () => void;
}) {
  const { status } = controller;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Resume quality
          </h2>
          <p className="max-w-prose text-sm text-content-tertiary">
            Run a small on-device model to judge bullet quality — weak verbs,
            missing metrics, vague language — and flag absent sections. The same
            run also surfaces "What an ATS misses." Nothing leaves this tab.
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
        <CritiqueDonePanel
          critique={status.critique}
          onGoToRewrite={onGoToRewrite}
        />
      )}
    </section>
  );
}

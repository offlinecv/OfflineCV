// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * CritiquePanel — body-only "Resume quality" results (issue #244).
 *
 * Exports `CritiqueResults`, a display-only component that renders the
 * on-device LLM content-quality critique body: summary feedback card (if
 * present), flagged bullet findings, and possibly-missing-sections list.
 *
 * The shell (header, Analyze CTA, status lifecycle) lives in
 * `ResumeQualityPanel`, which hosts both this component and
 * `DisagreementResults` under a single tab (#273).
 *
 * When 0 flagged bullets AND 0 missing sections, renders a neutral note
 * instead of the overclaiming "All bullets look strong" message (AC #6).
 *
 * Bullet finding rows include a "Rewrite this section →" nudge that
 * navigates to the "Reconstructed resume" tab, where the per-role wand
 * button (useSectionRewrite) already lives.
 *
 * Design rules (CLAUDE.md):
 *   - Semantic tokens only; no hardcoded hex or raw palette classes.
 *   - All interactive elements via <Button> from "@design-system".
 *   - No raw <button> in this file.
 */

import { Button, Card, StatusBadge } from "@design-system";
import type { BulletFinding, ResumeCritique } from "../../lib/webllm/critique-resume.ts";

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

// ── Public component ──────────────────────────────────────────────────────────

/**
 * Body-only critique results. Renders the critique content without a shell
 * (no header, no CTA, no status lifecycle). Consumed by `ResumeQualityPanel`.
 *
 * `onGoToRewrite` is optional; when provided it is threaded into each
 * `BulletFindingRow` so the user can jump to the rewrite affordance.
 */
export function CritiqueResults({
  critique,
  onGoToRewrite,
}: {
  critique: ResumeCritique;
  onGoToRewrite?: () => void;
}) {
  const flaggedBullets = critique.bulletFindings.filter((f) => f.issue !== "ok");
  const allOk =
    flaggedBullets.length === 0 && critique.missingSections.length === 0;

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

      {allOk ? (
        <p className="text-sm text-content-secondary">
          No specific bullet issues or missing sections were flagged. On-device
          analysis is limited and can miss things — treat this as a quick
          check, not a guarantee.
        </p>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * PerBulletFeedback — actionable per-bullet drill-down.
 *
 * Leads with a rollup summary (total + per-check failure counts), then a
 * single worst-first list of the bullets that need attention. Each failing
 * bullet appears exactly once, tagged with the checks it failed and a
 * compact "Rewrite" affordance (the WebGPU/Qwen2 pilot, failing bullets
 * only — passing bullets don't need it and stay collapsed).
 *
 * Earlier iterations grouped bullets into per-failure-mode <details>
 * sections, which duplicated any bullet that failed two checks and put a
 * heavy rewrite button under every row. The flat list dedupes and the
 * rewrite trigger is a low-weight inline link — see RewriteButton.
 */

import type { BulletObservation } from "../../lib/score/score.ts";
import { RewriteButton } from "./RewriteButton.tsx";

export function needsAttention(b: BulletObservation): boolean {
  return !b.hasMetric || !b.startsWithActionVerb || !b.wellFormedLength;
}

function lengthLabel(b: BulletObservation): string {
  if (b.wellFormedLength) return `${b.wordCount} words`;
  if (b.wordCount < 8) return `${b.wordCount} words — too short`;
  return `${b.wordCount} words — too long`;
}

function CheckChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-feedback-warning-bg text-feedback-warning-text">
      {label}
    </span>
  );
}

/**
 * One failing bullet. Text on the left; the failed-check chips and the slim
 * rewrite affordance sit inline on the right of the same line (wrapping to a
 * new line only on narrow viewports), keeping the row compact.
 */
function BulletRow({ bullet }: { bullet: BulletObservation }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border-light py-2 last:border-0">
      <p className="min-w-0 flex-1 text-sm leading-snug text-content-primary">
        <span className="mr-1.5 font-mono text-[11px] text-content-muted">
          #{bullet.index + 1}
        </span>
        {bullet.text}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        {!bullet.hasMetric && <CheckChip label="no metric" />}
        {!bullet.startsWithActionVerb && <CheckChip label="weak verb" />}
        {!bullet.wellFormedLength && <CheckChip label={lengthLabel(bullet)} />}
        <RewriteButton bullet={bullet.text} />
      </div>
    </li>
  );
}

export function PerBulletFeedback({
  bullets,
}: {
  bullets: BulletObservation[] | undefined;
}) {
  if (!bullets || bullets.length === 0) {
    return (
      <section
        id="per-bullet-feedback"
        className="scroll-mt-6 flex flex-col gap-2"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Per-bullet feedback
        </h2>
        <p className="text-sm text-content-tertiary">
          No bullet-shaped lines detected.
        </p>
      </section>
    );
  }

  const total = bullets.length;
  // Resume order — bullets are already index-ordered; filtering preserves it.
  const flagged = bullets.filter(needsAttention);
  const passing = total - flagged.length;

  const missingMetric = bullets.filter((b) => !b.hasMetric).length;
  const lengthIssues = bullets.filter((b) => !b.wellFormedLength).length;
  const weakVerb = bullets.filter((b) => !b.startsWithActionVerb).length;

  return (
    <section
      id="per-bullet-feedback"
      className="scroll-mt-6 flex flex-col gap-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Per-bullet feedback
      </h2>

      <p className="max-w-prose text-sm text-content-tertiary">
        Each bullet is checked against three rules: an action verb, the
        8–30-word length window, and a metric.
      </p>

      {flagged.length === 0 ? (
        <p className="text-sm font-medium text-feedback-success-text">
          All {total} bullet{total === 1 ? "" : "s"} pass every check.
        </p>
      ) : (
        <>
          {/* Rollup */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-border-light bg-surface-subtle px-3 py-2.5">
            <p className="text-sm font-medium text-content-primary">
              {flagged.length} of {total} bullet{total === 1 ? "" : "s"} need
              attention
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-content-secondary">
              {missingMetric > 0 && (
                <li className="tabular-nums">
                  <span className="font-semibold text-feedback-warning-text">
                    {missingMetric}
                  </span>{" "}
                  missing a metric
                </li>
              )}
              {lengthIssues > 0 && (
                <li className="tabular-nums">
                  <span className="font-semibold text-feedback-warning-text">
                    {lengthIssues}
                  </span>{" "}
                  length {lengthIssues === 1 ? "issue" : "issues"}
                </li>
              )}
              {weakVerb > 0 && (
                <li className="tabular-nums">
                  <span className="font-semibold text-feedback-warning-text">
                    {weakVerb}
                  </span>{" "}
                  weak verb{weakVerb === 1 ? "" : "s"}
                </li>
              )}
            </ul>
          </div>

          {/* Flat worst-first list — each failing bullet once */}
          <ul className="list-none">
            {flagged.map((b) => (
              <BulletRow key={b.index} bullet={b} />
            ))}
          </ul>

          {passing > 0 && (
            <p className="text-xs text-content-tertiary">
              {passing} bullet{passing === 1 ? "" : "s"} pass every check.
            </p>
          )}
        </>
      )}
    </section>
  );
}

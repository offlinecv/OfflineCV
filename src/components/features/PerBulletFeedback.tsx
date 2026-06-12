// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * PerBulletFeedback — actionable per-bullet drill-down.
 *
 * Leads with a rollup summary (total + per-check failure counts), then either:
 *   - GROUPED: flagged bullets organised under parsed-experience role headers
 *     ("Title — Company · dates"), with unmatched bullets under "Other bullets".
 *     Active when `experiences` is non-empty AND ≥1 flagged bullet matched a role.
 *   - FLAT: the original worst-first list. Falls back to this when experiences
 *     are absent or no bullet text matched any role description.
 *
 * Each failing bullet appears exactly once, tagged with the checks it failed
 * and a compact "Rewrite" affordance (the WebGPU/Qwen2 pilot — failing bullets
 * only; passing bullets don't need it and stay collapsed).
 *
 * BulletRow and RoleGroup live in RoleGroup.tsx to keep this file under ~200 LOC.
 */

import type { BulletObservation } from "../../lib/score/score.ts";
import type { BulletExperience } from "../../lib/score/group-bullets.ts";
import { groupBulletsByExperience } from "../../lib/score/group-bullets.ts";
import { BulletRow, RoleGroup } from "./RoleGroup.tsx";

export function needsAttention(b: BulletObservation): boolean {
  return !b.hasMetric || !b.startsWithActionVerb || !b.wellFormedLength;
}

export function PerBulletFeedback({
  bullets,
  experiences,
}: {
  bullets: BulletObservation[] | undefined;
  experiences?: BulletExperience[];
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

  // Decide grouped vs flat:
  //   grouped when experiences is non-empty AND ≥1 flagged bullet matched a role.
  const exps = experiences ?? [];
  const groups = exps.length > 0 ? groupBulletsByExperience(flagged, exps) : [];
  const useGrouped =
    exps.length > 0 && groups.some((g) => g.experienceIndex !== null);

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
          {/* Rollup — unchanged from flat version */}
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

          {useGrouped ? (
            /* Grouped: each role header followed by its flagged bullets */
            <div className="flex flex-col">
              {groups.map((group, i) => (
                <RoleGroup
                  key={group.experienceIndex ?? `other-${i}`}
                  group={group}
                />
              ))}
            </div>
          ) : (
            /* Flat fallback: original worst-first list */
            <ul className="list-none">
              {flagged.map((b) => (
                <BulletRow key={b.index} bullet={b} />
              ))}
            </ul>
          )}

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

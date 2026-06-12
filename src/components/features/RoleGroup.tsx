// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * RoleGroup — one collapsible section in the grouped per-bullet view.
 *
 * Renders a role header (Title — Company · dates, or "Other bullets" for
 * unmatched bullets) followed by the BulletRow list for that group.
 * Extracted from PerBulletFeedback to keep that component under ~200 LOC.
 */

import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { formatExperienceHeader } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import { RewriteButton } from "./RewriteButton.tsx";

// ── Shared sub-components (also used by PerBulletFeedback flat list) ──────────

function CheckChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-feedback-warning-bg text-feedback-warning-text">
      {label}
    </span>
  );
}

function lengthLabel(b: BulletObservation): string {
  if (b.wellFormedLength) return `${b.wordCount} words`;
  if (b.wordCount < 8) return `${b.wordCount} words — too short`;
  return `${b.wordCount} words — too long`;
}

export function BulletRow({ bullet }: { bullet: BulletObservation }) {
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

// ── RoleGroup ─────────────────────────────────────────────────────────────────

/**
 * One role section: a modest heading followed by its flagged bullets.
 * The heading is visually subordinate to the rollup — small-caps weight,
 * tertiary colour, light top margin.
 */
export function RoleGroup({ group }: { group: BulletGroup }) {
  const label =
    group.experience !== null
      ? formatExperienceHeader(group.experience)
      : "Other bullets";

  return (
    <div className="flex flex-col gap-0">
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">
        {label}
      </p>
      <ul className="list-none">
        {group.bullets.map((b) => (
          <BulletRow key={b.index} bullet={b} />
        ))}
      </ul>
    </div>
  );
}

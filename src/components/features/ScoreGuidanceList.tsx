// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ScoreGuidanceList — the located "what to change" rows (#810).
 *
 * Display-only. Every string it renders is built by `lib/score/guidance.ts`;
 * this file owns no copy and no derivation, so the advice cannot differ
 * between what is rendered here and what any other consumer of that module
 * would get.
 *
 * ITS ONE MOUNT IS `TargetingSection`, directly under `TargetingTriageRow`.
 * That pairing is the point: the triage row already says "4 of 12 bullets need
 * attention (3 missing a metric · 1 weak verb)" — the counts — and this says
 * which bullets and what to do about each. Two surfaces saying the aggregate
 * and the detail in one place, rather than a second triage panel elsewhere on
 * the page repeating the first one's counts.
 *
 * Reuse analysis (CLAUDE.md Reuse Gate). This is a new file under
 * `src/components/`, so it owes one:
 *   - It is NOT a new workflow surface. It renders inside the disclosure
 *     `TargetingSection` already owns, beneath the row that already owns
 *     bullet triage. No new panel, no new toggle, no new entry point — the
 *     score tiles' existing `#reconstructed-resume` / `#contact` anchors
 *     already land the user here.
 *   - It is a separate FILE rather than more lines in `TargetingTriageRow`
 *     because that file is already 185 LOC against the ~200 guideline, and
 *     CLAUDE.md says to prefer extracting into a sibling over growing a file
 *     past it. `SkillsOrderFinding.tsx` is the same split for the same reason
 *     — a finding row lifted out of a host at the limit, single-mounted.
 *   - Chrome is reused, not rebuilt: `StatusBadge` for the dimension label,
 *     and the `rounded border border-border-light bg-surface-subtle p-3` row
 *     shape `BulletFindingRow` and `SkillsOrderFindingRow` already use. No new
 *     shared piece was needed, and none was added.
 *
 * `tone="info"`, not `"warning"`, on the dimension badge. `StatusBadge`'s own
 * docblock records why: #204 added the `neutral` tone because giving every
 * unmet item a `warning` pill "would frame every unmet requirement as a
 * fault". The badge here names a SCORING DIMENSION — a category, not a
 * verdict on the line beside it — so it takes the same `info` tone
 * `SkillsOrderFindingRow` gives its own category chip. The warning colour
 * still appears on this surface, on `TargetingTriageRow`'s counts, where it
 * is actually counting gaps.
 *
 * Everything is rendered as TEXT. `ScoreDimensionRow`'s docblock is explicit
 * that hover-only prose (`title=`) is unreachable by keyboard and dead on
 * touch; this row carries the advice that matters most on the surface, so it
 * is never allowed to become a tooltip.
 */

import { StatusBadge } from "@design-system";
import type {
  GuidanceDimension,
  ScoreGuidanceItem,
} from "../../lib/score/guidance.ts";

/** Display names for the three dimensions, matching the score widget's own
 *  row labels so one dimension is called one thing across the page. */
const DIMENSION_LABEL: Record<GuidanceDimension, string> = {
  specificity: "Specificity",
  structure: "Structure",
  completeness: "Completeness",
};

interface ScoreGuidanceListProps {
  /** Built by `buildScoreGuidance`. Empty renders nothing at all. */
  items: readonly ScoreGuidanceItem[];
}

export function ScoreGuidanceList({ items }: ScoreGuidanceListProps) {
  // No chrome for a résumé with nothing to fix — an empty container with a
  // heading over it reads as a surface that failed to load (#810 acceptance:
  // "renders no guidance chrome, not an empty container").
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
        What to change
      </h3>
      <ul className="flex list-none flex-col gap-2">
        {items.map((item, i) => (
          <li
            // `where` is unique per row in practice (one path, one dimension,
            // one check) but the index is kept in the key so a résumé with two
            // identical bullet texts under one role cannot collide. The list
            // is derived deterministically and never reordered, so the index
            // is stable for as long as the input is.
            key={`${item.dimension}-${item.where}-${i}`}
            className="flex flex-col gap-1 rounded border border-border-light bg-surface-subtle p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="info">
                {DIMENSION_LABEL[item.dimension]}
              </StatusBadge>
              <span className="text-2xs font-medium text-content-secondary">
                {item.where}
              </span>
            </div>
            <p className="text-sm leading-snug text-content-secondary">
              {item.action}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

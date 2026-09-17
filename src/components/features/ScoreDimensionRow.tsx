// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ScoreDimensionRow — one compact horizontal dimension row (#953).
 *
 * Renders label, mini progress bar, and score fraction on one line, with the
 * hint caption below. Stays an `<a>` element to preserve the anchor contract
 * pinned by AtsScoreReadout.test.tsx.
 *
 * Every word this row has to say is rendered as TEXT. An earlier revision put
 * the Structure definition in a `title=` attribute, which is mouse-hover-only
 * — unreachable by keyboard and dead on touch — the same defect that got the
 * `title` tooltip removed from `VerdictHeader` in this very change. Definition
 * prose that applies to a dimension belongs in the scoring explainer popover,
 * which is focusable and reads out; per-résumé numbers belong here, visible.
 */

import type { SectionAnchor } from "../../lib/anchors.ts";
import { scoreBandParts } from "./scoreBand.ts";

export interface ScoreDimensionRowProps {
  label: string;
  value: number;
  max: number;
  gradable: boolean;
  hint: string;
  anchor: SectionAnchor;
}

export function formatCompletenessHint(completeness: {
  missing: string[];
  redactedDates?: boolean;
}): string {
  const base =
    completeness.missing.length === 0
      ? "All expected fields present"
      : `Missing: ${completeness.missing.join(", ")}`;
  return completeness.redactedDates
    ? `${base} · Dates appear redacted — use 4-digit years for best results.`
    : base;
}

export function ScoreDimensionRow({
  label,
  value,
  max,
  gradable,
  hint,
  anchor,
}: ScoreDimensionRowProps) {
  const { pct, barCls, valueCls } = scoreBandParts(value, max);

  return (
    <a
      href={anchor}
      className="flex flex-col gap-0.5 rounded px-1 py-0.5 hover:bg-surface-subtle"
    >
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-2xs font-semibold uppercase tracking-wider text-content-muted">
          {label}
        </span>
        {gradable ? (
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-subtle">
            <div
              className={`h-full rounded-full ${barCls}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : (
          <div className="flex-1 text-xs text-content-muted">—</div>
        )}
        {gradable && (
          <span className="w-12 shrink-0 text-right text-xs font-medium">
            <span className={valueCls}>{value}</span>
            <span className="text-content-muted">/{max}</span>
          </span>
        )}
      </div>
      <p className="text-2xs text-content-tertiary">{hint}</p>
    </a>
  );
}

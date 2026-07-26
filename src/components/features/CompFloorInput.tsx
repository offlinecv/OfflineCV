// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CompFloorInput — the optional minimum-annual-pay control for the Find Jobs
 * query (#564). Extracted out of `FindJobsPanel` (already at the ~200 LOC
 * gate) rather than grown inline — CLAUDE.md's component-size rule.
 *
 * A SOFT signal only, matching the #545/#561/#562 precedent already used for
 * location/specificity/seniority: `rankPostings` reads `query.compFloor` for
 * a sort-key penalty and `JobResultCard` reads `job.belowFloor` for a "below
 * your floor" badge, but a below-floor posting is never dropped from the
 * results. Purely local query state — never appended to any outbound
 * keyword/deep-link string; `providers/keywords.ts` stays the sole
 * resume-derived egress helper.
 */

import { EditableField } from "@design-system";

interface CompFloorInputProps {
  /** Undefined = no floor set (the default, byte-identical to pre-#564). */
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
}

export function CompFloorInput({ value, onCommit }: CompFloorInputProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {/* Named visibly by the caller's section heading (#602); the units stay
          here, where the value is typed. */}
      <span className="sr-only">Minimum pay</span>
      <span className="text-sm text-content-secondary">$/yr</span>
      <EditableField
        value={value !== undefined ? String(value) : undefined}
        placeholder="minimum pay"
        label="Minimum annual pay"
        onCommit={(raw) => {
          const digits = raw.trim().replace(/[^\d.]/g, "");
          if (!digits) {
            onCommit(undefined);
            return;
          }
          const parsed = Number(digits);
          onCommit(Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
        }}
      />
    </div>
  );
}

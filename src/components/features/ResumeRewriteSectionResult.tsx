// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { InlineDiff } from "@design-system";
import { computeTextDiff } from "../../lib/diff/text-diff.ts";
import type { SectionOutcome } from "../../lib/webllm/rewrite-resume.ts";
import { describeNumberDrift } from "./NumberPreservationWarning.tsx";

export function SectionResult({ outcome }: { outcome: SectionOutcome }) {
  if (outcome.kind === "summary") {
    return (
      <div className="flex flex-col gap-2 rounded border border-border-light bg-surface-card p-3">
        <h4 className="text-3xs font-semibold uppercase tracking-wider text-content-muted">
          {outcome.input.label}
        </h4>
        <InlineDiff
          segments={computeTextDiff(
            outcome.input.text,
            outcome.data.text || "",
          )}
          noChangeLabel={
            outcome.data.reverted ? revertedLabel(outcome.data) : undefined
          }
        />
      </div>
    );
  }
  // Both sides get the SAME blank filter. A revert hands back the input verbatim
  // (blanks included) while this side has always dropped them, so filtering only
  // the original made a section with one blank bullet diff as "changed" — which
  // suppressed the `noChangeLabel` that exists to stop a revert reading as a
  // silent no-op (#778).
  const originalBullets = withoutBlanks(outcome.input.bullets);
  const proposedBullets = withoutBlanks(outcome.data.bullets);
  return (
    <div className="flex flex-col gap-2 rounded border border-border-light bg-surface-card p-3">
      <h4 className="text-3xs font-semibold uppercase tracking-wider text-content-muted">
        {outcome.input.label}
      </h4>
      <InlineDiff
        segments={computeTextDiff(
          originalBullets.map((b) => `• ${b}`).join("\n"),
          proposedBullets.map((b) => `• ${b}`).join("\n"),
        )}
        noChangeLabel={
          outcome.data.reverted ? revertedLabel(outcome.data) : undefined
        }
      />
    </div>
  );
}

function withoutBlanks(bullets: readonly string[]): string[] {
  return bullets.filter((b) => b.trim().length > 0);
}

/**
 * Why a section in the whole-résumé review shows no redline (#778). Named per
 * section rather than aggregated into the résumé-level warning because the
 * chain rewrites each section independently — one reverting says nothing about
 * the others, and a single banner would leave the reader guessing which.
 */
function revertedLabel(data: {
  droppedNumbers: readonly string[];
  addedNumbers: readonly string[];
}): string {
  const detail = describeNumberDrift(data.droppedNumbers, data.addedNumbers);
  return detail === ""
    ? "Kept unchanged — the rewrite was rejected."
    : `Kept unchanged — the rewrite ${detail}.`;
}

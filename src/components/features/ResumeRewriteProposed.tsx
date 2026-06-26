// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Final "all sections rewritten" panel for the whole-résumé rewrite flow
 * (#67). Split out of `ResumeRewrite.tsx` so that file stays under the
 * ~200 LOC soft cap from CLAUDE.md and so each file's concern is single:
 *
 *   - `ResumeRewrite.tsx`         — CTA + state-routing + in-flight UI
 *     (StepIndicator, CompletedList, loading bar, error)
 *   - `ResumeRewriteProposed.tsx` — proposed-state UI: per-section
 *     before/after panels, aggregated metric-drift warning, discard CTA
 *
 * Reuse:
 *   - `Button` primitive from `@design-system` for the Discard CTA. No
 *     raw `<button>` in this file.
 *   - `NumberPreservationWarning` exported from `SectionRewrite.tsx` so
 *     the per-role and whole-résumé paths surface metric drift with
 *     identical copy — single source of truth for the warning string.
 *
 * `aggregateDrift` is exported so the test file can verify the
 * cross-section aggregation contract without re-rendering the whole panel.
 */

import { useMemo } from "react";
import { Button, InlineResult, InlineDiff } from "@design-system";
import { computeTextDiff } from "../../lib/diff/text-diff.ts";
import type {
  ResumeRewriteResult,
  SectionOutcome,
} from "../../lib/webllm/rewrite-resume.ts";
import { NumberPreservationWarning } from "./SectionRewrite.tsx";

export function ProposedPanel({
  result,
  onDismiss,
}: {
  result: ResumeRewriteResult;
  onDismiss: () => void;
}) {
  const aggregated = useMemo(() => aggregateDrift(result), [result]);
  return (
    <InlineResult
      tone={result.allNumbersPreserved ? "success" : "warning"}
      className="flex flex-col gap-4"
    >
      {!result.allNumbersPreserved && (
        <NumberPreservationWarning
          dropped={aggregated.dropped}
          added={aggregated.added}
        />
      )}
      <ul className="flex flex-col gap-4 list-none">
        {result.sections.map((outcome, i) => (
          <li key={`${outcome.kind}-${i}`}>
            <SectionResult outcome={outcome} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="link"
          size="sm"
          onClick={onDismiss}
          className="text-[11px] font-medium text-content-tertiary"
        >
          Discard
        </Button>
      </div>
    </InlineResult>
  );
}

function SectionResult({ outcome }: { outcome: SectionOutcome }) {
  if (outcome.kind === "summary") {
    return (
      <div className="flex flex-col gap-2 rounded border border-border-light bg-surface-card p-3">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
          {outcome.input.label}
        </h4>
        <InlineDiff
          segments={computeTextDiff(
            outcome.input.text,
            outcome.data.text || "",
          )}
        />
      </div>
    );
  }
  const originalBullets = outcome.input.bullets.filter(
    (b) => b.trim().length > 0,
  );
  return (
    <div className="flex flex-col gap-2 rounded border border-border-light bg-surface-card p-3">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
        {outcome.input.label}
      </h4>
      <InlineDiff
        segments={computeTextDiff(
          originalBullets.map((b) => `• ${b}`).join("\n"),
          outcome.data.bullets.map((b) => `• ${b}`).join("\n"),
        )}
      />
    </div>
  );
}

export interface AggregateDrift {
  dropped: string[];
  added: string[];
}

/**
 * Concatenate every section's dropped/added numeric tokens in encounter
 * order so the whole-résumé warning quotes the same specific metrics that
 * each per-section panel would have shown individually.
 *
 * Both `SectionOutcome` variants store the diff in `.data.droppedNumbers`
 * / `.data.addedNumbers`, so the kind discriminator doesn't change the
 * lookup — one shared loop covers both.
 */
export function aggregateDrift(result: ResumeRewriteResult): AggregateDrift {
  const dropped: string[] = [];
  const added: string[] = [];
  for (const outcome of result.sections) {
    dropped.push(...outcome.data.droppedNumbers);
    added.push(...outcome.data.addedNumbers);
  }
  return { dropped, added };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Number-preservation UI vocabulary (#778), shared by every surface that
 * shows the result of `checkNumbersPreserved` / `applyNumberPreservation`
 * (`src/lib/webllm/preserve-numbers.ts`, `post-process.ts`): the per-role
 * `SectionRewrite` panel, the whole-résumé `ProposedPanel`
 * (`ResumeRewriteProposed.tsx`), and the in-flight `CompletedList`
 * (`ResumeRewrite.tsx`). Split out of `SectionRewrite.tsx` (#874 review) so a
 * file already flagged as known debt over CLAUDE.md's ~200 LOC guidance
 * doesn't keep absorbing every future change to this vocabulary, and so the
 * three call sites read one classification instead of three independently
 * written ones that could drift out of sync.
 *
 * Pure presentation + one pure classifier — no component state, no hooks.
 */

/**
 * The one classification every number-preservation tone/badge decision in
 * the tree reduces to. `"reverted"` must be checked before `"drift"`:
 * `numbersPreserved` is true on a reverted rewrite by construction (#778),
 * so testing it first would read a reverted section as a clean pass.
 */
export type NumberDriftStatus = "reverted" | "drift" | "clean";

export function numberDriftStatus(result: {
  numbersPreserved: boolean;
  reverted: boolean;
}): NumberDriftStatus {
  if (result.reverted) return "reverted";
  if (!result.numbersPreserved) return "drift";
  return "clean";
}

/**
 * Caption the diff carries when a rewrite was rejected (#778). The two sides
 * are identical in that case, so without it the panel reads as "the model
 * looked at your bullets and changed nothing" — which is a different, and
 * false, story about what happened.
 */
export const REVERTED_DIFF_LABEL =
  "No changes applied — your original bullets.";

export function NumberPreservationWarning({
  dropped,
  added,
  reverted = false,
}: {
  dropped: readonly string[];
  added: readonly string[];
  /**
   * The rewrite was rejected and the original kept (#778). Changes the copy
   * from "check what the AI changed" to "nothing changed, and here's why" —
   * the delivered bullets are the user's own, so telling them to review a
   * metric they never lost would be wrong.
   */
  reverted?: boolean;
}) {
  const detail = describeNumberDrift(dropped, added);
  if (reverted) {
    return (
      <p
        role="alert"
        className="text-2xs leading-snug text-feedback-warning-text"
      >
        <span aria-hidden="true">⚠ </span>
        Kept your original — the rewrite {detail}, so I didn’t apply it. Try
        again for a different attempt.
      </p>
    );
  }
  return (
    <p role="alert" className="text-2xs leading-snug text-feedback-warning-text">
      <span aria-hidden="true">⚠ </span>
      AI altered a metric — {detail}. Review before saving.
    </p>
  );
}

/**
 * The one phrasing of "what the model did to the numbers", shared by the
 * revert notice, the drift warning, and the whole-résumé per-section label.
 * Both halves are named because the gate reverts on either since the #778
 * widening — quoting only the dropped ones left an invention-only revert
 * saying the rewrite dropped nothing at all.
 */
export function describeNumberDrift(
  dropped: readonly string[],
  added: readonly string[],
): string {
  const parts: string[] = [];
  if (dropped.length > 0) parts.push(`removed ${formatTokens(dropped)}`);
  if (added.length > 0) parts.push(`invented ${formatTokens(added)}`);
  return parts.join(" and ");
}

export function formatTokens(tokens: readonly string[]): string {
  if (tokens.length === 1) return tokens[0]!;
  if (tokens.length === 2) return `${tokens[0]} and ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(", ")}, and ${tokens[tokens.length - 1]}`;
}

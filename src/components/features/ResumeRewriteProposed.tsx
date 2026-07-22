// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

import { useCallback, useMemo } from "react";
import { Button, InlineResult, InlineDiff } from "@design-system";
import { computeTextDiff } from "../../lib/diff/text-diff.ts";
import type {
  ResumeRewriteResult,
  SectionOutcome,
} from "../../lib/webllm/rewrite-resume.ts";
import {
  alignBullets,
  type AlignedPair,
} from "../../lib/rewrite-review/align-bullets.ts";
import { resolveSectionWrites } from "../../lib/rewrite-review/apply-accepted.ts";
import { useRewriteReview, type RewriteReview } from "../../hooks/useRewriteReview.ts";
import {
  NumberPreservationWarning,
  type SectionRewriteApply,
} from "./SectionRewrite.tsx";
import { BulletReviewRow } from "./RewriteReviewList.tsx";

/** Per-section apply wiring for the whole-résumé review, keyed by the
 *  `SectionInput.id` (`experience:<index>`). Summary sections have no entry —
 *  they stay read-only redlines (no per-bullet model). */
export type ResumeRewriteApply = ReadonlyMap<string, SectionRewriteApply>;

/** One experience section made reviewable: its aligned pairs (ids namespaced
 *  by section so they're unique across the combined decision map) plus the
 *  apply handlers that write accepted bullets back. */
interface ReviewSection {
  id: string;
  label: string;
  pairs: AlignedPair[];
  apply: SectionRewriteApply;
}

export function ProposedPanel({
  result,
  onDismiss,
  onApplied,
  applyBySection,
}: {
  result: ResumeRewriteResult;
  /** Discard CTA only — Apply no longer calls this (#508; it calls
   *  `onApplied` instead so the confirmation shows in place). */
  onDismiss: () => void;
  /** Apply just committed its writes: the count of writes that actually
   *  landed — NOT `acceptedCount`, which includes accepted-but-verbatim pairs
   *  that resolve to no write — and the section labels that got one (#508).
   *  Never called with a count of 0; a zero-write batch dismisses instead. The caller shows the
   *  confirmation and holds the panel instead of dismissing synchronously.
   *  `undo` reverses the whole batch (issue 510) — undefined when any written
   *  section couldn't be snapshotted, so the control is never offered for a
   *  partial revert. */
  onApplied: (
    count: number,
    sections: readonly string[],
    undo?: () => void,
  ) => void;
  /** Per-section write-back handlers (#211 apply for the whole-résumé path).
   *  Absent → every section renders read-only (graceful fallback). */
  applyBySection?: ResumeRewriteApply;
}) {
  const aggregated = useMemo(() => aggregateDrift(result), [result]);

  // Experience sections with an apply wiring become per-bullet reviewable;
  // pair ids are namespaced by section id so the one combined decision map
  // below never collides (`alignBullets` reuses `m:i:j` / `add:j` across
  // sections). Everything else (summary) falls through to the read-only redline.
  const reviewSections = useMemo<ReviewSection[]>(() => {
    const out: ReviewSection[] = [];
    for (const outcome of result.sections) {
      if (outcome.kind !== "experience") continue;
      const apply = applyBySection?.get(outcome.input.id);
      if (!apply) continue;
      const pairs = alignBullets(outcome.input.bullets, outcome.data.bullets).map(
        (p): AlignedPair => ({ ...p, id: `${outcome.input.id}|${p.id}` }),
      );
      out.push({ id: outcome.input.id, label: outcome.input.label, pairs, apply });
    }
    return out;
  }, [result, applyBySection]);

  // ONE review hook over every section's pairs. Per-section incremental apply
  // is impossible — writing a section's bullets back changes `resumeSections`,
  // tripping the controller's stale-source guard, which dismisses the whole
  // proposal. So apply is global: accept across sections, then one Apply.
  const allPairs = useMemo(
    () => reviewSections.flatMap((s) => s.pairs),
    [reviewSections],
  );
  const review = useRewriteReview(allPairs);
  const reviewById = useMemo(
    () => new Map(reviewSections.map((s) => [s.id, s])),
    [reviewSections],
  );

  const onApply = useCallback(() => {
    // Track which sections actually got a write — an accepted-but-unedited
    // pair resolves to zero writes (resolveSectionWrites drops no-ops), so
    // "touched" is the writes list, not the section's accepted-pair count.
    const touchedSections: string[] = [];
    // Undo is all-or-nothing across the batch (issue 510): a per-section
    // snapshot is taken before that section's writes land, and the control is
    // offered only if EVERY written section handed one back. Reversing four
    // sections out of five would silently leave the résumé in a state the user
    // never authored — worse than offering no undo at all.
    const undos: (() => void)[] = [];
    let reversible = true;
    // The confirmation must report WRITES, not accepted pairs: accepting a
    // bullet whose rewrite equals the original is a legitimate accept the
    // Apply button counts, but it commits nothing. Announcing the accepted
    // count would claim changes that never landed.
    let writtenCount = 0;
    for (const sec of reviewSections) {
      const writes = resolveSectionWrites(
        sec.pairs,
        sec.apply.obsIndices,
        review.decisions,
        review.edits,
      );
      if (writes.length === 0) continue;
      writtenCount += writes.length;
      touchedSections.push(sec.label);
      const undo = sec.apply.captureUndo?.(writes);
      if (undo) undos.push(undo);
      else reversible = false;
      for (const w of writes) {
        if (w.kind === "add") sec.apply.onAdd(w.text);
        else if (w.kind === "replace") sec.apply.onReplace(w.obsIndex, w.text);
        else sec.apply.onRemove(w.obsIndex);
      }
    }
    // An all-verbatim batch commits nothing — no confirmation at all, or the
    // strip would announce "Applied N changes — " with an empty section list
    // and (on the per-role path) a live Undo over an empty snapshot. Fall back
    // to the pre-#508 behaviour: just drop the proposal.
    if (writtenCount === 0) {
      onDismiss();
      return;
    }
    onApplied(
      writtenCount,
      touchedSections,
      reversible && undos.length > 0
        ? () => {
            for (const undo of undos) undo();
          }
        : undefined,
    );
  }, [reviewSections, review.decisions, review.edits, onApplied, onDismiss]);

  const accepted = review.acceptedCount;

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
        {result.sections.map((outcome, i) => {
          const rs =
            outcome.kind === "experience"
              ? reviewById.get(outcome.input.id)
              : undefined;
          return (
            <li key={`${outcome.kind}-${i}`}>
              {rs ? (
                <ReviewSectionGroup section={rs} review={review} />
              ) : (
                <SectionResult outcome={outcome} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          onClick={onApply}
          disabled={accepted === 0}
          aria-label="Apply accepted changes to the resume"
        >
          {accepted === 0
            ? "Apply changes"
            : `Apply ${accepted} change${accepted === 1 ? "" : "s"}`}
        </Button>
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

/** One experience section in the whole-résumé review: a header with
 *  section-scoped Accept-all / Reject-all, then a `BulletReviewRow` per pair
 *  (the same row the per-role `RewriteReviewList` uses). */
function ReviewSectionGroup({
  section,
  review,
}: {
  section: ReviewSection;
  review: RewriteReview;
}) {
  const ids = section.pairs.map((p) => p.id);
  return (
    <div className="flex flex-col gap-2 rounded border border-border-light bg-surface-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
          {section.label}
        </h4>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => review.acceptMany(ids)}
            className="rounded-md px-2 py-0.5 text-[11px]"
          >
            Accept all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => review.rejectMany(ids)}
            className="rounded-md px-2 py-0.5 text-[11px] text-content-tertiary"
          >
            Reject all
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-2 list-none">
        {section.pairs.map((pair) => (
          <BulletReviewRow key={pair.id} pair={pair} review={review} />
        ))}
      </ul>
    </div>
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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RewriteReviewList — per-bullet accept/reject/edit surface for a rewrite
 * proposal (issue #211). Presentational: it renders one row per aligned pair
 * (from `alignBullets`) as an inline diff plus Accept / Reject / Edit controls,
 * a section-level Accept-all / Reject-all header, and a footer with the global
 * "Apply N" action. All decision state lives in the `useRewriteReview` hook the
 * caller owns (so the caller can drive Apply against the reconstructed résumé);
 * this component only reads `review` and calls its actions.
 *
 * Reuse (CLAUDE.md 3-tier rule):
 *   - `Button` primitive for every control — no raw `<button>`.
 *   - `InlineDiff` + `computeWordDiff` (#209) for each row's redline.
 *   - `EditableField` (multiline) for edit-in-place — the one inline-edit
 *     primitive, never a hand-rolled textarea.
 *   - Wrapped by the caller in the shared `InlineResult` strip, so this owns no
 *     panel chrome of its own.
 *
 * Row layout (readability, #211 follow-up): the clean *final* bullet is the
 * primary line (the editable field), with the redline demoted to a collapsed
 * "Show changes" disclosure underneath. Accept / Reject are icon-only toggles
 * (✓ / ✗) so a long list of rows reads as content, not a wall of buttons —
 * each keeps its descriptive `aria-label` + a hover `title`.
 *
 * The apply-confirmation state (#508) lives in the sibling
 * `ApplyConfirmation.tsx` rather than here — this file was already past the
 * ~200 LOC soft cap from CLAUDE.md.
 */

import { Button, EditableField, InlineDiff } from "@design-system";
import { computeWordDiff } from "../../lib/diff/text-diff.ts";
import type { AlignedPair } from "../../lib/rewrite-review/align-bullets.ts";
import type { RewriteReview } from "../../hooks/useRewriteReview.ts";

/** The text a pair currently shows as its "new" side: the user's edit if any,
 *  else the proposed text. Removed pairs have no new side. */
function newSideText(pair: AlignedPair, review: RewriteReview): string {
  if (pair.kind === "removed") return "";
  const edited = review.edits.get(pair.id);
  return edited !== undefined && edited.trim().length > 0
    ? edited
    : pair.proposed;
}

function oldSideText(pair: AlignedPair): string {
  return pair.kind === "added" ? "" : pair.original;
}

/** ✓ glyph for the Accept toggle. Decorative — the button owns the label. */
function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8.5l3.5 3.5L13 4" />
    </svg>
  );
}

/** ✗ glyph for the Reject toggle. Decorative — the button owns the label. */
function CrossIcon() {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

/** Disclosure chevron; rotates 90° when the parent <details> is open. */
function DisclosureChevron() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="transition-transform [details[open]_&]:rotate-90"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** One reviewable bullet: redline + accept/reject + (for non-removals) edit.
 *  Exported so the whole-résumé review (ResumeRewriteProposed) can reuse the
 *  same row under section headers — the single reviewable-bullet primitive. */
export function BulletReviewRow({
  pair,
  review,
}: {
  pair: AlignedPair;
  review: RewriteReview;
}) {
  const decision = review.decisionOf(pair.id);
  const accepted = decision === "accepted";
  const rejected = decision === "rejected";
  const editable = pair.kind !== "removed";

  const kindLabel =
    pair.kind === "added"
      ? "New bullet"
      : pair.kind === "removed"
        ? "Removed bullet"
        : "Edited bullet";

  const lower = kindLabel.toLowerCase();

  return (
    <li className="flex flex-col gap-1.5 rounded border border-border-light bg-surface-card p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
          {kindLabel}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant={accepted ? "primary" : "icon"}
            onClick={() => review.accept(pair.id)}
            aria-pressed={accepted}
            aria-label={`Accept this ${lower}`}
            title={accepted ? "Accepted" : "Accept"}
            className={`h-7 w-7 rounded-md ${
              accepted ? "" : "text-content-tertiary hover:text-feedback-success-text"
            }`}
          >
            <CheckIcon />
          </Button>
          <Button
            variant="icon"
            onClick={() => review.reject(pair.id)}
            aria-pressed={rejected}
            aria-label={`Reject this ${lower}`}
            title={rejected ? "Rejected" : "Reject"}
            className={`h-7 w-7 rounded-md ${
              rejected
                ? "border border-border bg-surface-hover text-content-secondary"
                : "text-content-tertiary hover:text-feedback-error-text"
            }`}
          >
            <CrossIcon />
          </Button>
        </div>
      </div>

      {editable ? (
        <>
          {/* Primary line: the clean, finished bullet — editable in place. */}
          <EditableField
            value={newSideText(pair, review)}
            placeholder="edit this bullet"
            emptyAffordance="plain"
            label="Edit proposed bullet"
            textSize="sm"
            display="inline"
            multiline
            onCommit={(v) => review.setEdit(pair.id, v)}
          />
          {/* Secondary: the redline, collapsed by default. Word-level so it
              reads as whole words, not the char-level "SupportLed" mash-up. */}
          <details className="mt-0.5">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-[11px] text-content-tertiary hover:text-content-secondary list-none [&::-webkit-details-marker]:hidden">
              <DisclosureChevron />
              Show changes
            </summary>
            <div className="mt-1.5">
              <InlineDiff
                segments={computeWordDiff(
                  oldSideText(pair),
                  newSideText(pair, review),
                )}
              />
            </div>
          </details>
        </>
      ) : (
        /* Removed bullet — no final version; show the struck original. */
        <InlineDiff segments={computeWordDiff(pair.original, "")} />
      )}
    </li>
  );
}

export function RewriteReviewList({
  pairs,
  review,
  onApply,
  onDiscard,
  warning,
}: {
  pairs: readonly AlignedPair[];
  review: RewriteReview;
  /** Apply the accepted decisions to the reconstructed résumé. */
  onApply: () => void;
  /** Drop the whole proposal back to idle. */
  onDiscard: () => void;
  /** Optional metric-drift warning rendered above the list. */
  warning?: React.ReactNode;
}) {
  const ids = pairs.map((p) => p.id);
  const total = pairs.length;
  const accepted = review.acceptedCount;

  return (
    <div className="flex flex-col gap-2.5">
      {warning}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-content-secondary">
          {total} change{total === 1 ? "" : "s"} proposed — review each below.
        </span>
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
        {pairs.map((pair) => (
          <BulletReviewRow key={pair.id} pair={pair} review={review} />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          onClick={onApply}
          disabled={accepted === 0}
          aria-label="Apply accepted changes to the resume"
        >
          {accepted === 0 ? "Apply changes" : `Apply ${accepted} change${accepted === 1 ? "" : "s"}`}
        </Button>
        <Button
          variant="link"
          size="sm"
          onClick={onDiscard}
          className="text-[11px] font-medium text-content-tertiary"
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

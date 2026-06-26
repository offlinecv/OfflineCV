// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 *   - `InlineDiff` + `computeTextDiff` (#209) for each row's redline.
 *   - `EditableField` (multiline) for edit-in-place — the one inline-edit
 *     primitive, never a hand-rolled textarea.
 *   - Wrapped by the caller in the shared `InlineResult` strip, so this owns no
 *     panel chrome of its own.
 */

import { Button, EditableField, InlineDiff } from "@design-system";
import { computeTextDiff } from "../../lib/diff/text-diff.ts";
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

/** One reviewable bullet: redline + accept/reject + (for non-removals) edit. */
function BulletReviewRow({
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

  return (
    <li className="flex flex-col gap-1.5 rounded border border-border-light bg-surface-card p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
          {kindLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={accepted ? "primary" : "ghost"}
            size="sm"
            onClick={() => review.accept(pair.id)}
            aria-pressed={accepted}
            aria-label={`Accept this ${kindLabel.toLowerCase()}`}
            className="rounded-md px-2 py-0.5 text-[11px]"
          >
            {accepted ? "Accepted" : "Accept"}
          </Button>
          <Button
            variant={rejected ? "primary" : "ghost"}
            size="sm"
            onClick={() => review.reject(pair.id)}
            aria-pressed={rejected}
            aria-label={`Reject this ${kindLabel.toLowerCase()}`}
            className="rounded-md px-2 py-0.5 text-[11px] text-content-tertiary"
          >
            {rejected ? "Rejected" : "Reject"}
          </Button>
        </div>
      </div>

      <InlineDiff
        segments={computeTextDiff(oldSideText(pair), newSideText(pair, review))}
      />

      {editable && (
        <EditableField
          value={newSideText(pair, review)}
          placeholder="edit this bullet"
          label="Edit proposed bullet"
          textSize="xs"
          display="inline"
          multiline
          onCommit={(v) => review.setEdit(pair.id, v)}
        />
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

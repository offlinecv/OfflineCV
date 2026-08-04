// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobDuplicateNotice — the inline "looks like the same posting" affordance on a
 * job tracker row (#746), with **Merge** and **Not the same**.
 *
 * The one product rule this component exists to hold: **nothing merges without
 * an explicit click.** Under-merging leaves a duplicate the user deletes in one
 * click; over-merging destroys a record — so this surface only ever *offers*.
 * The offer itself is gated on `probable` or better (`useJobDuplicates`), and
 * the click is a two-step confirm, the same shape the row's own Remove uses so
 * a stray click cannot collapse two applications into one.
 *
 * Merging is directional and the direction is the user's: the affordance shows
 * on BOTH rows of a pairing, and "Merge into this one" makes the row you are
 * reading the survivor. That is how the user picks which record's status,
 * notes-first-paragraph and canonical URL stay — see `job-merge.ts`, which
 * keeps the survivor's fields and fills only what it lacks.
 *
 * Split from `JobTrackerEntry` rather than grown into it, the way
 * `JobLetterIndicator` was: that file already sits past the ~200 LOC feature
 * guideline, and this is a self-contained offer → confirm → act state machine
 * rather than a couple of lines of row markup.
 *
 * Reuse analysis: `Button` from `@design-system`, no raw `<button>`, no
 * hand-rolled banner — the muted-panel look is `border-border-light` +
 * `bg-surface-subtle`, the same semantic tokens the row itself uses. No
 * `Dialog`: a modal for a suggestion the user is entitled to ignore would
 * interrupt a list they are scanning, which is what the inline confirm avoids.
 */

import { useState } from "react";
import { Button } from "@design-system";
import type { JobDuplicateSuggestion } from "../../hooks/useJobDuplicates.ts";

/** How the notice opens, per confidence. `certain` states the evidence because
 *  it HAS evidence — somebody recorded these two URLs as one posting — while
 *  `probable` is an inference and says so. A `possible` match never reaches
 *  this component; see `isActionableDuplicate`. */
const LEAD_IN: Record<JobDuplicateSuggestion["confidence"], string> = {
  certain: "Same posting as another saved job — they share a URL:",
  probable: "Looks like the same posting as another saved job:",
  possible: "May be the same posting as another saved job:",
};

interface JobDuplicateNoticeProps {
  /** The row this notice sits on. Becomes the SURVIVOR of any merge started
   *  here. */
  jobId: string;
  /** Actionable, undismissed matches for this row. Empty or omitted renders
   *  nothing — an untouched library carries no notice. */
  duplicates?: readonly JobDuplicateSuggestion[];
  /** `(survivorId, absorbedId)` — this row survives. */
  onMerge: (survivorId: string, absorbedId: string) => void;
  /** "Not the same": suppress this pairing durably, in both directions. */
  onDismiss: (a: string, b: string) => void;
}

export function JobDuplicateNotice({
  jobId,
  duplicates = [],
  onMerge,
  onDismiss,
}: JobDuplicateNoticeProps) {
  // The id of the match whose merge is awaiting confirmation, or null. A single
  // value rather than a set: confirming one suggestion while another is already
  // half-confirmed is a state with no user meaning.
  const [confirming, setConfirming] = useState<string | null>(null);

  if (duplicates.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {duplicates.map(({ job: other, confidence }) => (
        <div
          key={other.id}
          className="flex flex-col gap-1 rounded-md border border-border-light bg-surface-subtle p-2"
        >
          <p className="text-sm text-content-secondary">
            {LEAD_IN[confidence]}{" "}
            <span className="text-content-primary">{other.title || "Untitled job"}</span>
          </p>
          {other.url && (
            <span className="truncate text-xs text-content-muted">{other.url}</span>
          )}
          {confirming === other.id ? (
            <div className="flex flex-wrap items-center gap-1 text-sm text-content-secondary">
              <span>Keep this row and fold the other one into it?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setConfirming(null);
                  onMerge(jobId, other.id);
                }}
              >
                Confirm merge
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(other.id)}>
                Merge into this one
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onDismiss(jobId, other.id)}>
                Not the same
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

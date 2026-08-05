// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobTrackerEntry — one row of the job tracker (#323). Title / company / URL /
 * notes are inline-editable (`EditableField`); status switches via the shared
 * JobStatusPicker; the linked resume shows its name (or "Not linked") and
 * degrades to unlinked text if the resume was deleted. Picking a resume expands
 * an inline list of saved resumes rather than a dropdown — the same
 * button-list shape JobStatusPicker uses, so the row has one interaction
 * vocabulary. Remove is a two-click inline confirm so a stray click can't drop
 * a tracked application. All state access is the caller's `useJobTracker`
 * handlers — this component is presentational.
 *
 * Fitness rating (#700): the row reuses `RatingStars` and `describeRating`
 * verbatim, so a saved job and a searched one can never disagree about the same
 * posting. The caller computes it on view and never stores it on the record. A
 * record with no saved job description renders an explicit "not rated", NOT
 * zero stars — a 0 reads as "terrible fit" when the truth is that there is
 * nothing to match against.
 *
 * Letter indicator (#715): `letters` is this job's cover letters, most-
 * recently-updated first — passed straight to `JobLetterIndicator`, which
 * owns the click/acknowledge/reveal state machine and renders nothing when
 * the array is empty. Kept as a whole sibling component rather than inlined
 * here, both to reuse the "letters" concern and to avoid growing this file.
 *
 * Duplicate notice (#746): `duplicates` is other saved jobs that look like the
 * same posting, handed straight to `JobDuplicateNotice`, which owns the
 * offer → confirm → merge state machine and renders nothing when the list is
 * empty. Kept as a whole sibling component for the reason `JobLetterIndicator`
 * is: this file is already past the size guideline, and a merge is the one
 * action here that destroys a record, so it gets its own place to say so.
 *
 * Origin phrase (#745): `job.origin` is display-only provenance — "how did
 * this row get here" — and this is the one place in the app allowed to read
 * it (see `JobRecord.origin`'s docblock and the structural test that
 * enforces it). Deliberately a plain muted caption, not a second
 * `StatusBadge`: the badge above already answers "what stage is this at" via
 * `jobStatusLabel`, and a second chip repeating that would be noise. Renders
 * nothing when the field is absent, which is the common case — every job
 * this build's own UI creates has no origin.
 */

import { useState } from "react";
import { Button, EditableField, RatingStars, StatusBadge } from "@design-system";
import { JobStatusPicker, jobStatusTone, jobStatusLabel } from "./JobStatusPicker.tsx";
import { JobLetterIndicator } from "./JobLetterIndicator.tsx";
import { JobDuplicateNotice } from "./JobDuplicateNotice.tsx";
import type { JobDuplicateSuggestion } from "../../hooks/useJobDuplicates.ts";
import type { JobOrigin, JobRecord, JobStatus, LetterRecord } from "../../lib/storage/index.ts";
import type { JobPatch } from "../../lib/job-tracker.ts";
import { describeRating, type JobRating } from "../../lib/job-search/rating.ts";

/** One short phrase per {@link JobOrigin}, never a sentence — see the
 *  docblock above. A `Record`, not a lookup function, so a `JobOrigin` added
 *  without a phrase here is a compile error rather than a blank caption. */
const ORIGIN_PHRASE: Record<JobOrigin, string> = {
  capture: "captured from a posting",
  alert: "from a job alert",
  shared: "shared with you",
  import: "imported from a backup",
  manual: "added manually",
};

/** A saved resume the user can link this job to — the light shape the picker
 *  renders, structurally satisfied by `ResumeLibraryEntry`. */
export interface LinkableResume {
  id: string;
  filename: string;
}

interface JobTrackerEntryProps {
  job: JobRecord;
  /** Display name of the linked resume, or undefined when none is linked / the
   *  linked resume no longer exists (graceful degrade). */
  linkedResumeName?: string;
  /** Saved resumes offered by the link picker. Empty (or omitted) hides it —
   *  a user with no saved resumes has nothing to link. */
  resumeOptions?: readonly LinkableResume[];
  /** True once the library has been rated. False (the default) = nothing to rate
   *  against yet, so the row shows no fitness block rather than a placeholder. */
  rated?: boolean;
  /** This row's rating. Undefined WHILE `rated` means the record carries no job
   *  description → "Not rated", which is not the same state as 0 stars. */
  rating?: JobRating;
  /** This job's letters, most-recently-updated first (#715). Empty/omitted
   *  renders the "write one" state rather than nothing — see
   *  `JobLetterIndicator`. */
  letters?: readonly LetterRecord[];
  /** Re-read the letter store after this row writes one. */
  onLettersChanged?: () => Promise<void> | void;
  /** Other saved jobs that look like the same posting (#746). Rendered by the
   *  sibling `JobDuplicateNotice`, and only when both handlers below come with
   *  it — a merge offer with nowhere to send the click would be a button that
   *  lies. Omitted by any caller that has not run the sweep. */
  duplicates?: readonly JobDuplicateSuggestion[];
  /** `(survivorId, absorbedId)`, with THIS row as the survivor. */
  onMerge?: (survivorId: string, absorbedId: string) => void;
  onDismissDuplicate?: (a: string, b: string) => void;
  onUpdate: (id: string, patch: JobPatch) => void;
  onStatusChange: (id: string, status: JobStatus) => void;
  onLinkResume: (id: string, resumeId: string) => void;
  onUnlinkResume: (id: string) => void;
  onRemove: (id: string) => void;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function JobTrackerEntry({
  job,
  linkedResumeName,
  resumeOptions = [],
  rated = false,
  rating,
  letters,
  onLettersChanged,
  duplicates,
  onMerge,
  onDismissDuplicate,
  onUpdate,
  onStatusChange,
  onLinkResume,
  onUnlinkResume,
  onRemove,
}: JobTrackerEntryProps) {
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border-light p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <EditableField
            value={job.title || undefined}
            label="Job title"
            textSize="sm"
            onCommit={(v) => onUpdate(job.id, { title: v })}
          />
          <EditableField
            value={job.company || undefined}
            label="Company"
            textSize="sm"
            onCommit={(v) => onUpdate(job.id, { company: v })}
          />
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <StatusBadge tone={jobStatusTone(job.status)}>
              {jobStatusLabel(job.status)}
            </StatusBadge>
            <JobLetterIndicator
              jobId={job.id}
              letters={letters}
              onSaved={onLettersChanged}
            />
          </div>
          {job.origin && (
            <span className="text-xs text-content-muted">{ORIGIN_PHRASE[job.origin]}</span>
          )}
          {rated && !rating && (
            <span className="text-xs text-content-muted">
              Not rated · no job description saved
            </span>
          )}
          {rated && rating && (
            <>
              {/* No comp floor: the library carries no query, so `describeRating`
                  yields the fitness phrase alone (see `rate-saved-jobs.ts`). */}
              <RatingStars
                value={rating.overall}
                size="sm"
                showValue
                ariaLabel={`Resume fit: ${Math.round(rating.overall * 10) / 10} out of 5 stars`}
              />
              <span className="text-xs text-content-tertiary">
                {describeRating(rating, { hasCompFloor: false }).join(" · ")}
              </span>
            </>
          )}
        </div>
      </div>

      {duplicates && onMerge && onDismissDuplicate && (
        <JobDuplicateNotice
          jobId={job.id}
          duplicates={duplicates}
          onMerge={onMerge}
          onDismiss={onDismissDuplicate}
        />
      )}

      <JobStatusPicker
        value={job.status}
        onChange={(status) => onStatusChange(job.id, status)}
      />

      {job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-sm text-accent-primary hover:underline"
        >
          {job.url}
        </a>
      )}

      <EditableField
        value={job.notes || undefined}
        label="Notes"
        textSize="sm"
        onCommit={(v) => onUpdate(job.id, { notes: v })}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-content-muted">
        <span>
          {linkedResumeName ? (
            <>
              Resume: <span className="text-content-secondary">{linkedResumeName}</span>{" "}
              <Button variant="link" size="sm" onClick={() => onUnlinkResume(job.id)}>
                Unlink
              </Button>
            </>
          ) : (
            <>
              Not linked to a resume
              {resumeOptions.length > 0 && (
                <>
                  {" "}
                  <Button
                    variant="link"
                    size="sm"
                    aria-expanded={picking}
                    onClick={() => setPicking((open) => !open)}
                  >
                    {picking ? "Cancel" : "Link a resume"}
                  </Button>
                </>
              )}
            </>
          )}
          {" · "}Updated {formatDate(job.updatedAt)}
        </span>
        {confirming ? (
          <span className="flex items-center gap-1">
            <span className="text-content-secondary">Remove?</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => onRemove(job.id)}>
              Confirm
            </Button>
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>

      {picking && !linkedResumeName && resumeOptions.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Link a saved resume"
        >
          {resumeOptions.map((resume) => (
            <Button
              key={resume.id}
              variant="ghost"
              size="sm"
              onClick={() => {
                onLinkResume(job.id, resume.id);
                setPicking(false);
              }}
            >
              {resume.filename}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

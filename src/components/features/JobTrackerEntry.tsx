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
 */

import { useState } from "react";
import { Button, EditableField, StatusBadge } from "@design-system";
import { JobStatusPicker, jobStatusTone, jobStatusLabel } from "./JobStatusPicker.tsx";
import type { JobRecord, JobStatus } from "../../lib/storage/types.ts";
import type { JobPatch } from "../../lib/job-tracker.ts";

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
        <StatusBadge tone={jobStatusTone(job.status)}>
          {jobStatusLabel(job.status)}
        </StatusBadge>
      </div>

      <JobStatusPicker
        value={job.status}
        onChange={(status) => onStatusChange(job.id, status)}
      />

      {job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-xs text-accent-primary hover:underline"
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

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-content-muted">
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

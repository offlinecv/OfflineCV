// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobStatusPicker — the application-status control for a tracked job (#323). A
 * simple segmented picker over the linear lifecycle, not a workflow engine: the
 * current status is the primary button, the rest are ghost buttons that switch
 * to that status on click. Also exports the shared status → label / badge-tone
 * maps so the row badge and the picker never disagree.
 *
 * Selection is by BUCKET, not by string identity (#744). A row stored as
 * `shared` used to match none of the six and render with no selection at all —
 * six ghost buttons and no indication of where the job was. It now shows
 * Interested selected, and clicking Interested is a genuine no-op rather than a
 * write of `interested` over `shared`. Moving to a DIFFERENT bucket writes that
 * bucket's canonical status, which is the ordinary transition.
 */

import { Button, type StatusBadgeTone } from "@design-system";
import { JOB_STATUS_ORDER } from "../../lib/storage/index.ts";
import type { JobStatus } from "../../lib/storage/index.ts";
import { jobStatusBucket } from "../../lib/job-status-bucket.ts";

const STATUS_LABEL: Record<JobStatus, string> = {
  interested: "Interested",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  archived: "Archived",
};

/** Badge tone per status — shared with the row's `StatusBadge` so display and
 *  picker stay consistent. Module-private: consumers go through
 *  {@link jobStatusTone}, which adds the unknown-status fallback. */
const JOB_STATUS_TONE: Record<JobStatus, StatusBadgeTone> = {
  interested: "info",
  applied: "info",
  interviewing: "ok",
  offer: "ok",
  rejected: "warning",
  archived: "limited",
};

/** Display label for a status. Falls back to the raw string for a status that
 *  isn't in the canonical lifecycle — a corrupt or future-version imported
 *  record — so such a job renders with its literal status rather than a blank
 *  badge. `JobTracker` relies on this to surface, not swallow, unknown statuses. */
export function jobStatusLabel(status: string): string {
  return STATUS_LABEL[status as JobStatus] ?? status;
}

/** Badge tone for a status, with a neutral fallback for an unknown one, so a
 *  corrupt-status row still renders a valid badge instead of an empty class. */
export function jobStatusTone(status: string): StatusBadgeTone {
  return JOB_STATUS_TONE[status as JobStatus] ?? "info";
}

interface JobStatusPickerProps {
  /** The row's STORED status, which may sit outside `JobStatus` — a synced or
   *  imported record carries whatever its producer wrote, and the record
   *  contract preserves it verbatim. Typed `string` so that is stated rather
   *  than assumed away by the `JobStatus` on `JobRecord`. */
  value: string;
  /** Fired only for a bucket the row is not already in, and always with a
   *  canonical `JobStatus` — the picker never echoes a foreign status back. */
  onChange: (status: JobStatus) => void;
}

export function JobStatusPicker({ value, onChange }: JobStatusPickerProps) {
  const current = jobStatusBucket(value);
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Application status"
    >
      {JOB_STATUS_ORDER.map((status) => {
        const selected = status === current;
        return (
          <Button
            key={status}
            variant={selected ? "primary" : "ghost"}
            size="sm"
            aria-pressed={selected}
            // No handler at all on the selected bucket, rather than an
            // idempotent-looking `onChange(status)`. For a row stored as
            // `shared` that call would write `interested` — not a no-op but a
            // silent normalisation, destroying the meaning its producer
            // attached and bumping `updatedAt` for nothing. Left focusable and
            // enabled: `disabled` would drop the button out of the tab order,
            // and "you are already here" is not an unavailable action.
            onClick={selected ? undefined : () => onChange(status)}
          >
            {STATUS_LABEL[status]}
          </Button>
        );
      })}
    </div>
  );
}

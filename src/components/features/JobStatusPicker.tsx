// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobStatusPicker — the application-status control for a tracked job (#323). A
 * simple segmented picker over the linear lifecycle, not a workflow engine: the
 * current status is the primary button, the rest are ghost buttons that switch
 * to that status on click. Also exports the shared status → label / badge-tone
 * maps so the row badge and the picker never disagree.
 */

import { Button, type StatusBadgeTone } from "@design-system";
import { JOB_STATUS_ORDER } from "../../lib/storage/types.ts";
import type { JobStatus } from "../../lib/storage/types.ts";

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
  value: JobStatus;
  onChange: (status: JobStatus) => void;
}

export function JobStatusPicker({ value, onChange }: JobStatusPickerProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Application status"
    >
      {JOB_STATUS_ORDER.map((status) => (
        <Button
          key={status}
          variant={status === value ? "primary" : "ghost"}
          size="sm"
          aria-pressed={status === value}
          onClick={() => onChange(status)}
        >
          {STATUS_LABEL[status]}
        </Button>
      ))}
    </div>
  );
}

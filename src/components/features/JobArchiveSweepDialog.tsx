// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobArchiveSweepDialog — bulk-archive control for the Saved-jobs surface
 * (#759). Sibling of `ResumeLibraryImportDialog`: owns its own trigger
 * `Button` + `Dialog`, split into its own file so `JobTracker.tsx` (already
 * past the ~200 LOC guideline) doesn't grow further for this feature
 * (CLAUDE.md).
 *
 * The preview count and the write share ONE predicate — `jobsToArchive`
 * (`lib/job-archive-sweep.ts`) — computed here for the live count and handed
 * to `archiveOlderThan` unchanged: that function runs the identical
 * predicate over the identical `jobs` array this dialog was given. That
 * equality is the #759 acceptance criterion — the sweep can never select a
 * row on a policy the preview did not apply — and it is why `jobs` is a prop
 * rather than a fresh read inside this component.
 *
 * The number this dialog PRINTS on completion is the count `archiveOlderThan`
 * returns, never `toArchive.length`, and the distinction is deliberate. A row
 * that stopped being Interested while the sweep ran — another tab, the
 * extension, a sync — is skipped at the write rather than overwritten, so the
 * two can legitimately differ downward. Printing the returned count keeps
 * "Archived N jobs." a statement about writes that happened; printing the
 * preview would make it a statement about intent, which is the one place this
 * surface could quietly tell the user something untrue.
 *
 * The confirm step states the three things #759 names as decisions worth
 * getting wrong silently: the cutoff reads `createdAt` (when the job entered
 * this library) and never posting age; the sweep reaches only the Interested
 * bucket, never a row with hand-built pipeline state; and archiving
 * overwrites whatever vocabulary (`saved` / `scouted`) a synced row arrived
 * with — one-way, unlike the `archived` status itself.
 *
 * No toast on completion — this repo ships none (`@design-system`'s
 * CLAUDE.md). The dialog swaps its own content to a done state instead of
 * closing, the same "confirm in place" rule `ResumeLibraryImportDialog`'s
 * parent follows with `InlineResult`; kept inside this dialog rather than a
 * region in `JobTracker.tsx` because there's nowhere else on the page for a
 * "archived N jobs" result to attach to.
 */

import { useId, useState } from "react";
import { Button, Dialog, InlineResult } from "@design-system";
import { jobsToArchive } from "../../lib/job-archive-sweep.ts";
import type { JobRecord } from "../../lib/storage/index.ts";

/** Shown when the dialog opens. Long enough that a library synced within the
 *  last month doesn't greet the user with a same-day surprise count. */
const DEFAULT_CUTOFF_DAYS = 30;

interface JobArchiveSweepDialogProps {
  /** The tracker's current job list — the exact array `archiveOlderThan`
   *  reads, so the preview count computed here can't drift from the write. */
  jobs: readonly JobRecord[];
  /** `useJobTracker`'s bulk-archive sweep. */
  archiveOlderThan: (cutoffDays: number) => Promise<number>;
}

export function JobArchiveSweepDialog({
  jobs,
  archiveOlderThan,
}: JobArchiveSweepDialogProps) {
  const [open, setOpen] = useState(false);
  const [cutoffDays, setCutoffDays] = useState(DEFAULT_CUTOFF_DAYS);
  const [archiving, setArchiving] = useState(false);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);
  const inputId = useId();

  // NaN (an emptied or non-numeric input) and a non-positive value both mean
  // "no valid cutoff yet" — `jobsToArchive` would otherwise read a NaN cutoff
  // as "never matches" anyway, but checking here keeps the preview count and
  // the disabled Confirm in agreement without relying on that coincidence.
  const validCutoff = Number.isFinite(cutoffDays) && cutoffDays > 0;
  const toArchive = validCutoff ? jobsToArchive(jobs, cutoffDays) : [];

  function reset() {
    setOpen(false);
    setCutoffDays(DEFAULT_CUTOFF_DAYS);
    setArchivedCount(null);
  }

  async function handleConfirm() {
    setArchiving(true);
    try {
      setArchivedCount(await archiveOlderThan(cutoffDays));
    } finally {
      setArchiving(false);
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Archive old jobs
      </Button>

      <Dialog
        open={open}
        onClose={reset}
        title="Archive old jobs"
        className="max-w-sm"
      >
        {archivedCount !== null ? (
          <div className="flex flex-col gap-4">
            <InlineResult tone="success">
              Archived {archivedCount} {archivedCount === 1 ? "job" : "jobs"}.
            </InlineResult>
            <div className="flex justify-end">
              <Button variant="primary" onClick={reset}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-content-secondary">
              Moves jobs from your{" "}
              <span className="font-medium text-content-primary">
                Interested
              </span>{" "}
              list to Archived when they were added to your library more than
              this many days ago. Applied, Interviewing, Offer, and Rejected
              jobs are never touched.
            </p>

            <label
              htmlFor={inputId}
              className="flex items-center gap-2 text-sm text-content-secondary"
            >
              Added more than
              <input
                id={inputId}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={Number.isFinite(cutoffDays) ? cutoffDays : ""}
                disabled={archiving}
                onChange={(e) => setCutoffDays(e.target.valueAsNumber)}
                className="w-20 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
              />
              days ago
            </label>

            <p className="text-sm text-content-secondary">
              <span className="font-medium text-content-primary">
                {toArchive.length} {toArchive.length === 1 ? "job" : "jobs"}
              </span>{" "}
              will be archived.
            </p>

            <p className="text-sm text-content-tertiary">
              Every archived row&apos;s status becomes the literal{" "}
              <span className="font-medium">archived</span> — including a job
              that arrived as Saved or Scouted from a synced source, whose
              original label is gone once this runs. It also updates each
              row&apos;s last-modified time, which a syncing job board may
              push again on its next pass.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={reset} disabled={archiving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleConfirm()}
                disabled={archiving || toArchive.length === 0}
              >
                {archiving ? "Archiving…" : "Archive"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

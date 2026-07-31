// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobTracker — the saved-jobs surface (#323), sibling of ResumeLibrary. Lists
 * tracked jobs grouped by application status, surfaces the same storage-
 * persistence state + eviction transparency copy with a one-click backup export,
 * and offers a manual add. All local: nothing leaves the browser, no account, no
 * sync. Row rendering + status transitions live in JobTrackerEntry; storage
 * access is the `useJobTracker` hook. Renders an empty-state prompt until the
 * first job is added.
 *
 * Fitness ratings (#700) are computed on VIEW by `useSavedJobRatings` and never
 * stored on a record — a stored score would go stale the moment the résumé is
 * edited, with nothing to invalidate it. Rating needs a parsed résumé, which
 * this surface only has via the `/` handoff, so the library also stands alone
 * with none: `ratings === null` simply drops the fitness block from every row.
 */

import { useMemo } from "react";
import { Card, Button, StatusBadge } from "@design-system";
import { formatBytes } from "../../lib/format-bytes.ts";
import { EVICTION_NOTICE } from "../../lib/storage/index.ts";
import { JOB_STATUS_ORDER } from "../../lib/storage/index.ts";
import type { JobRecord, JobStatus } from "../../lib/storage/index.ts";
import { jobStatusLabel } from "./JobStatusPicker.tsx";
import { JobTrackerEntry, type LinkableResume } from "./JobTrackerEntry.tsx";
import { useJobTracker, type JobTracker as Tracker } from "../../hooks/useJobTracker.ts";
import { useSavedJobRatings } from "../../hooks/useSavedJobRatings.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import type { JobRating } from "../../lib/job-search/rating.ts";

interface JobTrackerProps {
  tracker: Tracker;
  /** Fitness rating per job id, or null when the library has not been rated —
   *  no résumé in this tab, or the pass is still resolving. A job id ABSENT from
   *  a non-null map has no saved job description; its row says "not rated"
   *  rather than showing a zero (see `rate-saved-jobs.ts`). */
  ratings?: ReadonlyMap<string, JobRating> | null;
  /** Whether a parsed résumé reached this tab at all — the difference between
   *  "nothing to rate against" and "rated". Drives the one-line explanation, so
   *  an unrated library is never silently unexplained. */
  hasResume?: boolean;
  /** Resolve a linked resume id to its display name; returns undefined when the
   *  resume no longer exists, so the row degrades to "not linked". */
  resumeName?: (resumeId: string) => string | undefined;
  /** Saved resumes a row's link picker offers. Omitted / empty hides the
   *  picker, so the tracker still stands alone with an empty library. */
  resumeOptions?: readonly LinkableResume[];
}

/**
 * Entry point that OWNS the hook, so `useJobTracker` mounts only where the
 * tracker actually renders (on `/jobs/`, since #690) rather than on every
 * surface that imports this module. {@link JobTracker} stays tracker-injected
 * so tests drive it with a fake.
 */
export function JobTrackerSection({
  parsed,
  ...props
}: Omit<JobTrackerProps, "tracker" | "ratings" | "hasResume"> & {
  /** The résumé saved jobs are rated against — the `/` handoff `JobsApp` holds.
   *  Must be referentially stable; `useSavedJobRatings` deps on it directly. */
  parsed?: HeuristicParsedResume;
}) {
  const tracker = useJobTracker();
  const ratings = useSavedJobRatings(tracker.jobs, parsed);
  return (
    <JobTracker
      tracker={tracker}
      ratings={ratings}
      hasResume={parsed !== undefined}
      {...props}
    />
  );
}

export function JobTracker({
  tracker,
  ratings = null,
  hasResume = false,
  resumeName,
  resumeOptions,
}: JobTrackerProps) {
  const { jobs, ready, persisted, usageBytes, update, setStatus, link, unlink, remove, create, exportBackup } =
    tracker;

  // One pass, bucketed by each job's ACTUAL status string — canonical lifecycle
  // statuses in order first, then any status not in JOB_STATUS_ORDER (a corrupt
  // or future-version imported record). Keying the render on JOB_STATUS_ORDER
  // alone would silently drop such a job: it'd still count toward the header
  // total but appear in no section, so the count would exceed the visible rows.
  const groups = useMemo(() => {
    const buckets = new Map<string, JobRecord[]>();
    for (const job of jobs) {
      const bucket = buckets.get(job.status);
      if (bucket) bucket.push(job);
      else buckets.set(job.status, [job]);
    }
    const known = JOB_STATUS_ORDER.filter((status) => buckets.has(status));
    const unknown = [...buckets.keys()]
      .filter((status) => !JOB_STATUS_ORDER.includes(status as JobStatus))
      .sort();
    return [...known, ...unknown].map((status) => ({
      status,
      jobs: buckets.get(status) ?? [],
    }));
  }, [jobs]);

  if (!ready) return null;

  return (
    <Card className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-content-primary">
            Tracked jobs
          </h2>
          <span className="text-sm text-content-muted">
            {jobs.length}
            {usageBytes !== null && <> · {formatBytes(usageBytes)} used</>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone={persisted ? "ok" : "warning"}>
            {persisted ? "Persistent" : "Best-effort"}
          </StatusBadge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void create({ title: "New job" })}
          >
            Add a job
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void exportBackup()}>
            Export backup
          </Button>
        </div>
      </header>

      <p className="text-sm text-content-tertiary">
        Saved only in this browser — no account, no sync.{" "}
        {!persisted && EVICTION_NOTICE}
      </p>

      {!hasResume && jobs.length > 0 && (
        <p className="text-sm text-content-muted">
          Open this workbench from your resume to see how each saved job fits it.
        </p>
      )}

      {jobs.length === 0 ? (
        <p className="text-sm text-content-muted">
          No tracked jobs yet. Add a job, or save one from a JD match.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(({ status, jobs: group }) => (
              <section key={status} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
                  {jobStatusLabel(status)} · {group.length}
                </h3>
                <ul className="flex flex-col gap-2">
                  {group.map((job) => (
                    <JobTrackerEntry
                      key={job.id}
                      job={job}
                      linkedResumeName={
                        job.resumeId !== undefined
                          ? resumeName?.(job.resumeId)
                          : undefined
                      }
                      resumeOptions={resumeOptions}
                      rated={ratings !== null}
                      rating={ratings?.get(job.id)}
                      onUpdate={(id, patch) => void update(id, patch)}
                      onStatusChange={(id, next) => void setStatus(id, next)}
                      onLinkResume={(id, resumeId) => void link(id, resumeId)}
                      onUnlinkResume={(id) => void unlink(id)}
                      onRemove={(id) => void remove(id)}
                    />
                  ))}
                </ul>
              </section>
          ))}
        </div>
      )}
    </Card>
  );
}

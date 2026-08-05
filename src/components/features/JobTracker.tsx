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
 * this surface has either via the `/` handoff or, absent one, the #724 fallback
 * (`JobsApp` → `useFallbackResume`, the most recently saved library résumé) —
 * with neither, `ratings === null` simply drops the fitness block from every
 * row. `fallbackResumeName` is set only in the fallback case, so a row's stars
 * always name which résumé they were computed against.
 *
 * Letters (#715): `JobTrackerSection` owns `useJobLetters` the same way it
 * owns `useSavedJobRatings` — one read for the whole library, grouped by job
 * id and handed down as `lettersById`. A job id absent from the map renders
 * no indicator (`JobTrackerEntry` → `JobLetterIndicator`).
 *
 * Collapse + paging (#740): this file keeps the grouping and the open-by-default
 * POLICY; `JobTrackerStatusGroup` owns one bucket's open/closed and page state,
 * which the parent cannot hold because the bucket count is data, not a fixed
 * set of `useState`s.
 */

import { useMemo } from "react";
import { Card, Button, StatusBadge } from "@design-system";
import { formatBytes } from "../../lib/format-bytes.ts";
import { EVICTION_NOTICE, JOB_STATUS_ORDER } from "../../lib/storage/index.ts";
import type { JobRecord, JobStatus, LetterRecord } from "../../lib/storage/index.ts";
import { JobTrackerEntry, type LinkableResume } from "./JobTrackerEntry.tsx";
import { JobTrackerStatusGroup, isCollapsedByDefault } from "./JobTrackerStatusGroup.tsx";
import { useJobTracker, type JobTracker as Tracker } from "../../hooks/useJobTracker.ts";
import { useSavedJobRatings } from "../../hooks/useSavedJobRatings.ts";
import { useJobLetters } from "../../hooks/useJobLetters.ts";
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
  /** Filename of the résumé backing `ratings`, set ONLY when it came from the
   *  #724 fallback (the most recently saved library résumé) rather than the
   *  `/` handoff. A star with an unstated referent is the failure mode
   *  `rate-saved-jobs.ts` property 1 already guards against in the other
   *  direction — this names it. Undefined for the handoff case (the user just
   *  came from their résumé, so naming it would be redundant) and whenever
   *  there is nothing to rate against. */
  fallbackResumeName?: string;
  /** Resolve a linked resume id to its display name; returns undefined when the
   *  resume no longer exists, so the row degrades to "not linked". */
  resumeName?: (resumeId: string) => string | undefined;
  /** Saved resumes a row's link picker offers. Omitted / empty hides the
   *  picker, so the tracker still stands alone with an empty library. */
  resumeOptions?: readonly LinkableResume[];
  /** Every letter, grouped by job id (#715) — `useJobLetters`' shape. A job id
   *  absent from the map has no letters, so its row renders no indicator. */
  lettersById?: ReadonlyMap<string, readonly LetterRecord[]>;
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
}: Omit<JobTrackerProps, "tracker" | "ratings" | "hasResume" | "lettersById"> & {
  /** The résumé saved jobs are rated against — the `/` handoff `JobsApp` holds.
   *  Must be referentially stable; `useSavedJobRatings` deps on it directly. */
  parsed?: HeuristicParsedResume;
}) {
  const tracker = useJobTracker();
  const ratings = useSavedJobRatings(tracker.jobs, parsed);
  const letters = useJobLetters();
  return (
    <JobTracker
      tracker={tracker}
      ratings={ratings}
      hasResume={parsed !== undefined}
      lettersById={letters.byJobId}
      {...props}
    />
  );
}

export function JobTracker({
  tracker,
  ratings = null,
  hasResume = false,
  fallbackResumeName,
  resumeName,
  resumeOptions,
  lettersById,
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

  // Would ANY section open on mount? `groups` holds only non-empty buckets, so
  // this is false just for a library that is nothing but rejected/archived —
  // which would otherwise render as a page of headers over no rows, the very
  // failure collapse-by-default exists to avoid. Then every section opens; the
  // "only non-empty bucket is rejected" case is the single-bucket case of it.
  const anyOpenByDefault = groups.some(({ status }) => !isCollapsedByDefault(status));

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

      {/* #724: only set when `ratings` came from the fallback most-recently-
          saved résumé rather than a real `/` handoff — names the referent so a
          fit star is never shown against an unstated resume. */}
      {hasResume && fallbackResumeName && jobs.length > 0 && (
        <p className="text-sm text-content-muted">
          Fit vs.{" "}
          <span className="text-content-secondary">{fallbackResumeName}</span>{" "}
          — your most recently saved resume.
        </p>
      )}

      {jobs.length === 0 ? (
        <p className="text-sm text-content-muted">
          No tracked jobs yet. Add a job, or save one from a JD match.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(({ status, jobs: group }) => (
            <JobTrackerStatusGroup
              key={status}
              status={status}
              jobs={group}
              defaultExpanded={!anyOpenByDefault || !isCollapsedByDefault(status)}
              renderRow={(job) => (
                <JobTrackerEntry
                  job={job}
                  linkedResumeName={
                    job.resumeId !== undefined
                      ? resumeName?.(job.resumeId)
                      : undefined
                  }
                  resumeOptions={resumeOptions}
                  rated={ratings !== null}
                  rating={ratings?.get(job.id)}
                  letters={lettersById?.get(job.id)}
                  onUpdate={(id, patch) => void update(id, patch)}
                  onStatusChange={(id, next) => void setStatus(id, next)}
                  onLinkResume={(id, resumeId) => void link(id, resumeId)}
                  onUnlinkResume={(id) => void unlink(id)}
                  onRemove={(id) => void remove(id)}
                />
              )}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

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
 *
 * Duplicates (#746): `JobTrackerSection` owns `useJobDuplicates` the same way it
 * owns the two hooks above — one sweep for the whole library, grouped by job id
 * and handed down. Computed on VIEW and never stored, for the reason ratings
 * are: a stored "these two are the same posting" verdict goes stale the moment
 * a title is edited. Nothing here merges anything; the row's notice offers, and
 * `tracker.merge` only ever runs from a click on it.
 *
 * Repost clusters (#754): a third derived-on-view sweep, `useJobRepostClusters`,
 * over the same `tracker.jobs`. It feeds two things — the `JobRepostClusterList`
 * statement above the sections, and `useJobDuplicates`, which withholds the
 * merge offer for pairings inside a cluster. The ORDER of those two hook calls
 * is load-bearing: the clusters must exist before the duplicate sweep can
 * suppress against them. One role a company has re-listed six times is not five
 * redundant records, and offering thirty merges on it would have destroyed the
 * churn signal a click at a time.
 *
 * Buckets, not raw statuses (#744): sections key on `jobStatusBucket(status)`,
 * so a synced record's `saved` / `scouted` / `shared` share the one Interested
 * section instead of splitting one pipeline stage into four. That mapping is
 * strictly a VIEW concern — this surface never writes a normalised status back
 * over what a producer stored.
 *
 * Bulk-archive sweep (#759): `JobArchiveSweepDialog` owns the whole feature —
 * trigger, cutoff input, live preview count, confirm, and the done state — as
 * its own sibling file, so this header only wires it to `tracker.jobs` and
 * `tracker.archiveOlderThan`. Unlike the three sweeps above, this ONE writes:
 * the dialog's own docblock covers why that write is safe.
 *
 * Repost sweep: the second bulk write, and it lives in the repost section's own
 * header rather than this one, because it is scoped to what that section lists
 * and vanishes when nothing in it is still sweepable. Same wiring shape —
 * `tracker.jobs` plus `tracker.archiveReposted`, passed through
 * `JobRepostClusterList` to `JobRepostArchiveDialog`, which owns the whole
 * feature.
 */

import { useMemo } from "react";
import { Card, Button, StatusBadge } from "@design-system";
import { formatBytes } from "../../lib/format-bytes.ts";
import { EVICTION_NOTICE, JOB_STATUS_ORDER, isKnownStatus } from "../../lib/storage/index.ts";
import type { JobRecord, LetterRecord } from "../../lib/storage/index.ts";
import { jobStatusBucket } from "../../lib/job-status-bucket.ts";
import { JobTrackerEntry, type LinkableResume } from "./JobTrackerEntry.tsx";
import { JobTrackerStatusGroup, isCollapsedByDefault } from "./JobTrackerStatusGroup.tsx";
import { JobRepostClusterList } from "./JobRepostClusterList.tsx";
import { JobArchiveSweepDialog } from "./JobArchiveSweepDialog.tsx";
import { useJobTracker, type JobTracker as Tracker } from "../../hooks/useJobTracker.ts";
import { useSavedJobRatings } from "../../hooks/useSavedJobRatings.ts";
import { useJobLetters } from "../../hooks/useJobLetters.ts";
import {
  useJobDuplicates,
  type JobDuplicateSuggestion,
} from "../../hooks/useJobDuplicates.ts";
import { useJobRepostClusters } from "../../hooks/useJobRepostClusters.ts";
import type { JobRepostCluster } from "../../lib/job-repost-clusters.ts";
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
  /** Re-read the letter store after a row writes one. Optional so a caller
   *  that only displays letters need not supply one; without it a saved letter
   *  will not appear until this view remounts. */
  onLettersChanged?: () => Promise<void> | void;
  /** Other saved jobs that look like the same posting, per job id (#746) —
   *  `useJobDuplicates`' shape, already filtered to `probable`-or-better and to
   *  pairings the user has not dismissed. Omitted renders no notice anywhere,
   *  which is what a caller that has not run the sweep should get. */
  duplicatesByJobId?: ReadonlyMap<string, readonly JobDuplicateSuggestion[]>;
  /** "Not the same" — suppress one pairing durably. Required alongside
   *  `duplicatesByJobId` for either to reach a row. */
  onDismissDuplicate?: (a: string, b: string) => void;
  /** Roles this library holds more than one record of, spread over more than
   *  `REPOST_SPAN_DAYS` (#754) — `useJobRepostClusters`' shape. Stated once each
   *  above the sections; the member records still render in their own status
   *  sections. Omitted renders no statement, which is what a caller that has not
   *  run the sweep should get. */
  repostClusters?: readonly JobRepostCluster[];
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
}: Omit<
  JobTrackerProps,
  | "tracker"
  | "ratings"
  | "hasResume"
  | "lettersById"
  | "onLettersChanged"
  | "duplicatesByJobId"
  | "onDismissDuplicate"
  | "repostClusters"
> & {
  /** The résumé saved jobs are rated against — the `/` handoff `JobsApp` holds.
   *  Must be referentially stable; `useSavedJobRatings` deps on it directly. */
  parsed?: HeuristicParsedResume;
}) {
  const tracker = useJobTracker();
  const ratings = useSavedJobRatings(tracker.jobs, parsed);
  const letters = useJobLetters();
  // Before `useJobDuplicates`, which suppresses against it — see the docblock.
  const reposts = useJobRepostClusters(tracker.jobs);
  const duplicates = useJobDuplicates(tracker.jobs, reposts.byJobId);
  return (
    <JobTracker
      tracker={tracker}
      ratings={ratings}
      hasResume={parsed !== undefined}
      lettersById={letters.byJobId}
      onLettersChanged={letters.refresh}
      duplicatesByJobId={duplicates.byJobId}
      onDismissDuplicate={duplicates.dismiss}
      repostClusters={reposts.clusters}
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
  onLettersChanged,
  duplicatesByJobId,
  onDismissDuplicate,
  repostClusters,
}: JobTrackerProps) {
  const {
    jobs,
    ready,
    persisted,
    usageBytes,
    update,
    setStatus,
    link,
    unlink,
    remove,
    merge,
    create,
    exportBackup,
    archiveOlderThan,
    archiveReposted,
  } = tracker;

  // One pass, bucketed by each job's DISPLAY bucket rather than its literal
  // status string (#744): a synced record's `saved` / `scouted` / `shared` are
  // one stage of a job search, not three, and this surface renders stages. The
  // record itself is untouched — `jobStatusBucket` maps at VIEW time only, and
  // the row badge still prints the stored status verbatim.
  //
  // Canonical lifecycle buckets in order first, then any bucket `jobStatusBucket`
  // could not map (a corrupt or future-version imported record), sorted. Keying
  // the render on JOB_STATUS_ORDER alone would silently drop such a job: it'd
  // still count toward the header total but appear in no section, so the count
  // would exceed the visible rows.
  const groups = useMemo(() => {
    const buckets = new Map<string, JobRecord[]>();
    for (const job of jobs) {
      const key = jobStatusBucket(job.status);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(job);
      else buckets.set(key, [job]);
    }
    const known = JOB_STATUS_ORDER.filter((status) => buckets.has(status));
    const unknown = [...buckets.keys()].filter((key) => !isKnownStatus(key)).sort();
    return [...known, ...unknown].map((bucket) => ({
      bucket,
      jobs: buckets.get(bucket) ?? [],
    }));
  }, [jobs]);

  // Would ANY section open on mount? `groups` holds only non-empty buckets, so
  // this is false just for a library that is nothing but rejected/archived —
  // which would otherwise render as a page of headers over no rows, the very
  // failure collapse-by-default exists to avoid. Then every section opens; the
  // "only non-empty bucket is rejected" case is the single-bucket case of it.
  const anyOpenByDefault = groups.some(({ bucket }) => !isCollapsedByDefault(bucket));

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
          <JobArchiveSweepDialog jobs={jobs} archiveOlderThan={archiveOlderThan} />
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
          {/* Above the pipeline, not inside it: a cluster's members are spread
              across status buckets, so no section owns the statement. */}
          <JobRepostClusterList
            clusters={repostClusters}
            jobs={jobs}
            archiveReposted={archiveReposted}
          />
          {groups.map(({ bucket, jobs: group }) => (
            <JobTrackerStatusGroup
              key={bucket}
              bucket={bucket}
              jobs={group}
              defaultExpanded={!anyOpenByDefault || !isCollapsedByDefault(bucket)}
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
                  onLettersChanged={onLettersChanged}
                  duplicates={duplicatesByJobId?.get(job.id)}
                  onMerge={(survivorId, absorbedId) =>
                    void merge(survivorId, absorbedId)
                  }
                  onDismissDuplicate={onDismissDuplicate}
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

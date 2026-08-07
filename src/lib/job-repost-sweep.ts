// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-repost-sweep — the predicate behind "archive reposted roles" (#754
 * follow-up). Pure, zero-storage, zero-UI: it answers "which saved records does
 * that one button touch?" and nothing else. Sibling of `job-archive-sweep.ts`,
 * and split from it rather than folded in because the two sweeps select on
 * different evidence — that module's cutoff is a CLOCK read over one record,
 * this one's membership is a GROUPING over the whole library. Same shape as
 * every other selection module here (`job-duplicates.ts`,
 * `job-repost-clusters.ts`): testable at module scope, nothing written.
 *
 * ## Why a repost cluster is now archivable, when #754 offered nothing
 *
 * #754 deliberately shipped the cluster list with no action on it: the thing on
 * offer then was **merge**, which is destructive, cascades letters, and would
 * have destroyed the very churn signal the list exists to state. Archiving is
 * the other kind of action — it is a status move, the record and its letters
 * survive intact, and the cluster itself is computed over the whole library
 * including archived rows, so sweeping a cluster does not erase it from the
 * list. That is what makes this offerable where a merge was not: the evidence
 * outlives the action.
 *
 * ## What it may touch — the SAME bucket rule, not a second one
 *
 * Only rows whose {@link isSweepableBucket} is true, i.e. bucket `interested`.
 * The predicate is IMPORTED from `job-archive-sweep.ts`, never restated, for
 * the reason that module gives for exporting it separately: a user's hand-built
 * pipeline state (`applied` / `interviewing` / `offer` / `rejected`) is not a
 * sweep's to overwrite, and one spelling of that rule means the guarantee both
 * confirm dialogs state cannot drift between them. A row already `archived`
 * simply never matches, so running this twice is a no-op the second time.
 *
 * That import also means this sweep inherits the store-side re-check for free:
 * `archiveJobs` is handed the same `isSweepableBucket` and re-judges each row
 * the instant before its write, so a row someone moved to Applied mid-sweep is
 * skipped rather than overwritten.
 *
 * ## Every member, not every-but-the-latest
 *
 * A role listed seven times over 51 days is the ghost-job reading: the user is
 * clearing the role, not de-duplicating it. Keeping the newest member back
 * would leave one live row per cluster — the clutter the sweep was reached for
 * — and would need a "newest" tiebreak over `createdAt` values this module has
 * already established can be unreadable. So membership alone selects, and the
 * bucket rule above is the only filter.
 *
 * Note this is the opposite direction from `job-archive-sweep.ts`'s
 * unreadable-`createdAt` rule, and consistently so: THERE an unreadable date
 * means the age test cannot be evaluated, so the row is spared. Here no date is
 * consulted at all — membership comes from {@link jobCompanyTitleKey}, which is
 * text — so there is nothing to be unsure about. A member with no usable
 * `createdAt` is what put its group in a cluster in the first place
 * (`findRepostClusters` treats an unreadable time as "not within the span"),
 * and sparing it would leave the one row the user most wants gone.
 */

import { isSweepableBucket } from "./job-archive-sweep.ts";
import type { JobRepostCluster } from "./job-repost-clusters.ts";
import type { JobRecord } from "./storage/index.ts";

/**
 * Every job in `jobs` that belongs to one of `clusters` AND sits in a bucket a
 * sweep may touch, in the caller's order.
 *
 * The one function both the dialog's live preview count and the write use — the
 * equality `JobArchiveSweepDialog` already establishes for the age sweep, for
 * the same reason: the set a user confirms a number for must be the set that
 * gets written.
 *
 * Selection runs over `jobs` rather than over `cluster.ids` so the result is a
 * list of RECORDS (the bucket rule needs one) in the library's own order, and
 * so an id in a cluster that no longer exists in `jobs` — a record removed
 * between the sweep and this call — simply drops out instead of reaching
 * storage as a lookup that misses.
 */
export function repostedJobsToArchive(
  jobs: readonly JobRecord[],
  clusters: readonly JobRepostCluster[],
): JobRecord[] {
  if (clusters.length === 0) return [];
  const members = new Set<string>();
  for (const cluster of clusters) {
    for (const id of cluster.ids) members.add(id);
  }
  return jobs.filter((job) => members.has(job.id) && isSweepableBucket(job));
}

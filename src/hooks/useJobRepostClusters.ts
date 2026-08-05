// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJobRepostClusters — the tracker's view of "which saved rows are one role
 * this employer keeps re-listing" (#754). A thin subscription wrapper in the
 * shape `useJobDuplicates` established, which is the shape
 * `useSectionRewriteLock` established: every rule that decides anything lives in
 * `src/lib/job-repost-clusters.ts` (pure, testable at module scope) and this
 * hook holds only the memo.
 *
 * Not even one piece of state, unlike `useJobDuplicates` — there is nothing to
 * dismiss. A repost cluster makes no offer, so there is nothing for a user to
 * decline; it is a statement about the library, and the library is the whole
 * input.
 *
 * ## Derived on VIEW, never stored
 *
 * The rule `useJobDuplicates` and `useSavedJobRatings` follow: a stored verdict
 * goes stale the moment a title is edited, with nothing to invalidate it. So the
 * sweep runs over the current list, bucketed rather than quadratic for exactly
 * this reason, and nothing on the write path is touched.
 */

import { useMemo } from "react";
import {
  findRepostClusters,
  indexRepostClusters,
  type JobRepostCluster,
} from "../lib/job-repost-clusters.ts";
import type { JobRecord } from "../lib/storage/index.ts";

export interface JobRepostClusters {
  /** Every cluster in the library, in bucket-discovery order. Empty for a
   *  library with no re-listed role, which is the common case. */
  clusters: readonly JobRepostCluster[];
  /** The same clusters keyed by member id. A job id absent from the map is in
   *  no cluster. */
  byJobId: ReadonlyMap<string, JobRepostCluster>;
}

export function useJobRepostClusters(jobs: readonly JobRecord[]): JobRepostClusters {
  // `jobs` alone: both functions are module imports, and the sweep reads
  // nothing else. `useJobTracker` hands down a fresh array on every tracker
  // write (including a cross-tab one since #760), which is exactly when the
  // answer can change.
  return useMemo(() => {
    const clusters = findRepostClusters(jobs);
    return { clusters, byJobId: indexRepostClusters(clusters) };
  }, [jobs]);
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJobDuplicates — the tracker's view of "which saved jobs look like the same
 * posting" (#746). A thin subscription wrapper, in the shape
 * `useSectionRewriteLock` establishes: every rule that decides anything lives in
 * `src/lib/job-duplicates.ts` (pure, testable at module scope) and
 * `src/lib/job-duplicate-dismissals.ts` (the durable "Not the same"), and this
 * hook only holds the memo and the one piece of state.
 *
 * ## Computed on VIEW, never stored
 *
 * The same rule `useSavedJobRatings` follows: a stored "these two are
 * duplicates" verdict would go stale the moment the user edits a title, with
 * nothing to invalidate it. So the sweep runs over the current list.
 * `findDuplicatePairs` is indexed rather than quadratic for exactly this reason.
 *
 * ## Only actionable matches come out
 *
 * `possible` matches are dropped here rather than in the lib: the pure module's
 * job is to report every tier it can distinguish, and the decision that a
 * merge affordance needs `probable` or better is a product one
 * ({@link isActionableDuplicate} states it once, and this is its only caller).
 * A pairing the user dismissed is filtered on the same pass — reading the
 * dismissals fresh into state at mount, so a reload does not re-offer a merge
 * the user already declined.
 *
 * ## And neither do pairings inside a repost cluster (#754)
 *
 * Third filter on the same pass, from the same principle. `isRepostSuppressed`
 * owns the precedence rule and states why in full; the short form is that
 * cluster membership outranks an inferred tier and is outranked by URL
 * identity, so a genuine shared-URL double-capture inside a cluster keeps its
 * offer while the repost pairings lose theirs. The clusters are the caller's to
 * pass — `useJobRepostClusters` derives them from the same `jobs` array — so
 * this hook stays usable on its own and a caller that has not swept simply gets
 * the pre-#754 behaviour.
 */

import { useCallback, useMemo, useState } from "react";
import {
  findDuplicatePairs,
  isActionableDuplicate,
  jobPairKey,
  type JobDuplicateConfidence,
} from "../lib/job-duplicates.ts";
import {
  dismissJobPair,
  readDismissedJobPairs,
} from "../lib/job-duplicate-dismissals.ts";
import {
  isRepostSuppressed,
  type JobRepostCluster,
} from "../lib/job-repost-clusters.ts";
import type { JobRecord } from "../lib/storage/index.ts";

/** One "this row may be the same posting as that one" suggestion, resolved to
 *  the other record so a row can name it. */
export interface JobDuplicateSuggestion {
  /** The OTHER job — the one this row would absorb on a merge. */
  job: JobRecord;
  confidence: JobDuplicateConfidence;
}

export interface JobDuplicates {
  /** Actionable, undismissed suggestions per job id. A job id absent from the
   *  map has none, so its row renders nothing. */
  byJobId: ReadonlyMap<string, readonly JobDuplicateSuggestion[]>;
  /** "Not the same" — suppress this pairing durably, in both directions. */
  dismiss: (a: string, b: string) => void;
}

export function useJobDuplicates(
  jobs: readonly JobRecord[],
  /** Repost clusters over the SAME `jobs` array (`useJobRepostClusters`).
   *  Omitted suppresses nothing, which is what a caller that has not run that
   *  sweep should get. */
  repostsByJobId?: ReadonlyMap<string, JobRepostCluster>,
): JobDuplicates {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() =>
    readDismissedJobPairs(),
  );

  const byJobId = useMemo(() => {
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const suggestions = new Map<string, JobDuplicateSuggestion[]>();
    for (const pair of findDuplicatePairs(jobs)) {
      if (!isActionableDuplicate(pair.confidence)) continue;
      if (dismissed.has(jobPairKey(pair.a, pair.b))) continue;
      if (repostsByJobId !== undefined && isRepostSuppressed(pair, repostsByJobId)) continue;
      const a = byId.get(pair.a);
      const b = byId.get(pair.b);
      if (a === undefined || b === undefined) continue;
      // Both directions: whichever row the user is looking at should be able to
      // be the survivor, which is how they choose which record's status stays.
      push(suggestions, a.id, { job: b, confidence: pair.confidence });
      push(suggestions, b.id, { job: a, confidence: pair.confidence });
    }
    return suggestions;
    // `repostsByJobId` is derived from `jobs` by a sibling memo, so it can only
    // change when `jobs` already has — listing it costs no extra re-fire and
    // stops a caller that passes a differently-derived map from reading a stale
    // suppression. (`exhaustive-deps` is not enforced in this repo; this array
    // is hand-audited both directions.)
  }, [jobs, dismissed, repostsByJobId]);

  const dismiss = useCallback((a: string, b: string) => {
    dismissJobPair(a, b);
    // Re-read rather than adding to the in-memory set, so the state can never
    // claim a suppression that localStorage refused to store (a full quota, a
    // locked-down browser). The prompt returning is the honest outcome there.
    setDismissed(readDismissedJobPairs());
  }, []);

  return { byJobId, dismiss };
}

function push(
  index: Map<string, JobDuplicateSuggestion[]>,
  key: string,
  value: JobDuplicateSuggestion,
): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}

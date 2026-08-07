// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJobTracker — UI-facing state over the job-tracker domain layer (#323).
 * Owns the reactive job list plus the storage-persistence signal and the
 * approximate space-used figure; delegates all persistence to
 * `src/lib/job-tracker.ts` and `src/lib/storage`. Every mutation refreshes the
 * list so the view stays in sync without the caller re-fetching. Sibling of
 * {@link useResumeLibrary}, and reuses the same persistence/eviction plumbing so
 * the durability messaging is identical across both surfaces.
 */

import { useCallback, useEffect, useState } from "react";
import {
  listJobs,
  createJob,
  updateJob,
  setJobStatus,
  linkResume,
  unlinkResume,
  removeJob,
  mergeJobs,
  createTrackedJobFromMatch,
  archiveInterestedOlderThan,
  archiveRepostedRoles,
  type NewJobInput,
  type JobPatch,
} from "../lib/job-tracker.ts";
import type { JobRepostCluster } from "../lib/job-repost-clusters.ts";
import {
  requestStoragePersistence,
  isStoragePersisted,
  downloadStorageBackup,
} from "../lib/storage/index.ts";
import { estimateStorageUsage } from "../lib/resume-library.ts";
import type { JobRecord, JobStatus } from "../lib/storage/index.ts";
import { useLibraryChanges } from "./useLibraryChanges.ts";

export interface JobTracker {
  jobs: JobRecord[];
  /** True once the initial list load has resolved. */
  ready: boolean;
  /** IndexedDB persistence grant: true = exempt from eviction, false =
   *  best-effort (surface the eviction notice, same copy as the resume library). */
  persisted: boolean;
  /** Approximate bytes used by this origin's storage, or null if unknown. */
  usageBytes: number | null;
  create: (input: NewJobInput) => Promise<string>;
  update: (id: string, patch: JobPatch) => Promise<void>;
  setStatus: (id: string, status: JobStatus) => Promise<void>;
  link: (id: string, resumeId: string) => Promise<void>;
  unlink: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Fold `absorbedId` into `survivorId` (#746): the survivor keeps its own
   *  fields and gains the other's, including its URL as an alias, and the
   *  absorbed record is tombstoned. Never called except from an explicit user
   *  click — see `mergeJobs`. */
  merge: (survivorId: string, absorbedId: string) => Promise<void>;
  /** "Save this job" from the JD-match flow — carries JD text + match result. */
  saveFromMatch: (
    input: Parameters<typeof createTrackedJobFromMatch>[0],
  ) => Promise<string>;
  /** Download the full storage export as a JSON backup file. */
  exportBackup: () => Promise<void>;
  /** Bulk-archive sweep (#759): archives every Interested job in the CURRENT
   *  `jobs` list whose `createdAt` is more than `cutoffDays` days old, and
   *  returns the count archived. Reads the same `jobs` array a caller's own
   *  `jobsToArchive` preview would see, so the confirmed count and the
   *  archived count can never disagree. */
  archiveOlderThan: (cutoffDays: number) => Promise<number>;
  /** Repost sweep: archives every Interested job belonging to one of
   *  `clusters` — `useJobRepostClusters`' derived-on-view output — and returns
   *  the count archived. Takes the clusters rather than re-deriving them, so
   *  the set swept is the set the user was shown a count for. */
  archiveReposted: (clusters: readonly JobRepostCluster[]) => Promise<number>;
  refresh: () => Promise<void>;
}

export function useJobTracker(): JobTracker {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const [usageBytes, setUsageBytes] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [list, usage] = await Promise.all([
      listJobs(),
      estimateStorageUsage(),
    ]);
    setJobs(list);
    setUsageBytes(usage);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    void isStoragePersisted().then(setPersisted);
  }, [refresh]);

  // Re-read on a `jobs` write this hook did not itself make (#760) — another
  // tab, a restored backup, an out-of-tree producer writing through
  // `putRecord`. Own mutations below already call `refresh()` directly and
  // never trigger this (`onLibraryChange` never delivers a tab's own post).
  useLibraryChanges("jobs", refresh);

  /** Ask for durable storage on the first write and reflect the grant, so the
   *  UI can drop the eviction warning — mirrors `useResumeLibrary.save`. */
  const ensurePersistence = useCallback(async () => {
    const granted = await requestStoragePersistence();
    setPersisted((prev) => prev || granted);
  }, []);

  const create = useCallback(
    async (input: NewJobInput) => {
      await ensurePersistence();
      const job = await createJob(input);
      await refresh();
      return job.id;
    },
    [ensurePersistence, refresh],
  );

  const update = useCallback(
    async (id: string, patch: JobPatch) => {
      await updateJob(id, patch);
      await refresh();
    },
    [refresh],
  );

  const setStatus = useCallback(
    async (id: string, status: JobStatus) => {
      await setJobStatus(id, status);
      await refresh();
    },
    [refresh],
  );

  const link = useCallback(
    async (id: string, resumeId: string) => {
      await linkResume(id, resumeId);
      await refresh();
    },
    [refresh],
  );

  const unlink = useCallback(
    async (id: string) => {
      await unlinkResume(id);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeJob(id);
      await refresh();
    },
    [refresh],
  );

  const merge = useCallback(
    async (survivorId: string, absorbedId: string) => {
      await mergeJobs(survivorId, absorbedId);
      await refresh();
    },
    [refresh],
  );

  const saveFromMatch = useCallback(
    async (input: Parameters<typeof createTrackedJobFromMatch>[0]) => {
      await ensurePersistence();
      const job = await createTrackedJobFromMatch(input);
      await refresh();
      return job.id;
    },
    [ensurePersistence, refresh],
  );

  const exportBackup = useCallback(() => downloadStorageBackup(), []);

  const archiveOlderThan = useCallback(
    async (cutoffDays: number) => {
      const count = await archiveInterestedOlderThan(jobs, cutoffDays);
      await refresh();
      return count;
    },
    [jobs, refresh],
  );

  const archiveReposted = useCallback(
    async (clusters: readonly JobRepostCluster[]) => {
      const count = await archiveRepostedRoles(jobs, clusters);
      await refresh();
      return count;
    },
    [jobs, refresh],
  );

  return {
    jobs,
    ready,
    persisted,
    usageBytes,
    create,
    update,
    setStatus,
    link,
    unlink,
    remove,
    merge,
    saveFromMatch,
    exportBackup,
    archiveOlderThan,
    archiveReposted,
    refresh,
  };
}

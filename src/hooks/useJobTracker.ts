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
  createTrackedJobFromMatch,
  type NewJobInput,
  type JobPatch,
} from "../lib/job-tracker.ts";
import {
  requestStoragePersistence,
  isStoragePersisted,
  downloadStorageBackup,
} from "../lib/storage/index.ts";
import { estimateStorageUsage } from "../lib/resume-library.ts";
import type { JobRecord, JobStatus } from "../lib/storage/types.ts";

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
  /** "Save this job" from the JD-match flow — carries JD text + match result. */
  saveFromMatch: (
    input: Parameters<typeof createTrackedJobFromMatch>[0],
  ) => Promise<string>;
  /** Download the full storage export as a JSON backup file. */
  exportBackup: () => Promise<void>;
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
    saveFromMatch,
    exportBackup,
    refresh,
  };
}

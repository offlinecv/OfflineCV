// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useResumeLibrary — UI-facing state over the resume-library domain layer
 * (#322). Owns the reactive list, the storage-persistence signal, and the
 * approximate space-used figure; delegates all persistence to
 * `src/lib/resume-library.ts` and `src/lib/storage`. Mutations refresh the list
 * so the picker stays in sync without the caller re-fetching.
 */

import { useCallback, useEffect, useState } from "react";
import {
  listLibrary,
  saveResumeToLibrary,
  loadResumeFromLibrary,
  renameLibraryResume,
  removeLibraryResume,
  estimateStorageUsage,
  type ResumeLibraryEntry,
  type LoadedResume,
} from "../lib/resume-library.ts";
import {
  requestStoragePersistence,
  isStoragePersisted,
  downloadStorageBackup,
} from "../lib/storage/index.ts";
import { clearResumeLink } from "../lib/job-tracker.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";

export interface SaveResumeParams {
  id?: string;
  filename: string;
  bytes?: ArrayBuffer;
  sourceKind: "pdf" | "docx" | "markdown";
  result: CascadeResult;
  score: AnonymousAtsScore;
}

export interface ResumeLibrary {
  entries: ResumeLibraryEntry[];
  /** True once the initial list load has resolved. */
  ready: boolean;
  /** IndexedDB persistence grant: true = exempt from eviction, false =
   *  best-effort (surface the eviction notice). */
  persisted: boolean;
  /** Approximate bytes used by this origin's storage, or null if unknown. */
  usageBytes: number | null;
  save: (params: SaveResumeParams) => Promise<string>;
  load: (id: string) => Promise<LoadedResume | undefined>;
  rename: (id: string, filename: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Download the full storage export as a JSON backup file. */
  exportBackup: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useResumeLibrary(): ResumeLibrary {
  const [entries, setEntries] = useState<ResumeLibraryEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const [usageBytes, setUsageBytes] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [list, usage] = await Promise.all([
      listLibrary(),
      estimateStorageUsage(),
    ]);
    setEntries(list);
    setUsageBytes(usage);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    void isStoragePersisted().then(setPersisted);
  }, [refresh]);

  const save = useCallback(
    async (params: SaveResumeParams) => {
      // Ask for durable storage on first save; reflect the grant so the UI can
      // drop the eviction warning when it's granted.
      const granted = await requestStoragePersistence();
      setPersisted((prev) => prev || granted);
      const id = await saveResumeToLibrary(params);
      await refresh();
      return id;
    },
    [refresh],
  );

  const load = useCallback((id: string) => loadResumeFromLibrary(id), []);

  const rename = useCallback(
    async (id: string, filename: string) => {
      await renameLibraryResume(id, filename);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeLibraryResume(id);
      try {
        // Graceful degrade (#323 AC): a tracked job that pointed at this resume
        // keeps its record and loses only the dangling link. Runs after the
        // delete so a failure here can never leave the resume undeleted — and
        // is caught so it can't skip the refresh below either, which would
        // leave the just-deleted resume on screen until something re-lists.
        // `reconcileResumeLinks` is the backstop for a link missed here.
        await clearResumeLink(id);
      } catch {
        // Swallowed deliberately: the resume IS gone, and a stale link is a
        // cosmetic "Not linked" degrade, not a failure worth blocking the UI.
      }
      await refresh();
    },
    [refresh],
  );

  const exportBackup = useCallback(() => downloadStorageBackup(), []);

  return {
    entries,
    ready,
    persisted,
    usageBytes,
    save,
    load,
    rename,
    remove,
    exportBackup,
    refresh,
  };
}

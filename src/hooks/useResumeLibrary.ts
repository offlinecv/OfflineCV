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
  importFromJson,
  clearLetterResumeLink,
  type ImportCounts,
} from "../lib/storage/index.ts";
import { clearResumeLink, reconcileResumeLinks } from "../lib/job-tracker.ts";
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
  /** Restore a backup file into this origin's storage. `merge` upserts by id;
   *  `replace` wipes both stores first. Refreshes the list on success. Jobs the
   *  capture contract refused come back in `skippedJobs` (#693) — the caller
   *  must surface them, since a silently-dropped record is indistinguishable
   *  from a record the file never had. */
  importBackup: (file: File, mode: "merge" | "replace") => Promise<ImportCounts>;
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
      // Graceful degrade (#323 AC, #711): a tracked job and a cover letter both
      // carry the same optional résumé link, and both keep their record and lose
      // only the dangling link — the prose the user wrote is not the résumé's to
      // take with it. Runs after the delete so a failure here can never leave the
      // resume undeleted.
      //
      // `allSettled` does two jobs, which is why there is no `try`/`catch` here.
      // It stops either repair starving the other — the asymmetry is what makes
      // that matter, since jobs have `reconcileResumeLinks` (called on
      // merge-import below) as a backstop for a link missed here while letters
      // have no equivalent sweep, so a skipped letter link stays dangling until
      // the letter is rewritten. And because it never rejects, it is also the
      // swallow: the resume IS gone, and a stale link is a cosmetic "Not linked"
      // degrade, not a failure worth blocking the UI or skipping the refresh for.
      await Promise.allSettled([clearResumeLink(id), clearLetterResumeLink(id)]);
      await refresh();
    },
    [refresh],
  );

  const exportBackup = useCallback(() => downloadStorageBackup(), []);

  const importBackup = useCallback(
    async (file: File, mode: "merge" | "replace") => {
      const counts = await importFromJson(await file.text(), mode);
      if (mode === "merge") {
        // Merge upserts by id and never deletes, so it can't itself drop an
        // existing resume — but an INCOMING job can carry a resumeId this
        // device never had and this backup didn't include either (e.g. a
        // partial or stale export from another device). Read survivors
        // straight from the store, after the write above, not from the
        // `entries` state (stale — captured before this import ran), so the
        // sweep reconciles against what's actually there. Same graceful
        // degrade `remove()` gives the delete path, via the belt-and-
        // suspenders sweep `reconcileResumeLinks` (#547) exists for.
        //
        // The sweep deliberately does NOT re-run the capture contract (#693).
        // Every record it can reach is already in the store, having passed the
        // validator on the way in or been written by the typechecked domain
        // layer, and the only field it writes is `resumeId: undefined` — a
        // narrowing write that cannot introduce an invalid value. Validating on
        // a repair path would let a record the user can already see fail its
        // way out of existence, turning a display problem into data loss.
        const survivors = await listLibrary();
        await reconcileResumeLinks(new Set(survivors.map((r) => r.id)));
      }
      // Replace mode skips the sweep: it wipes both stores and rebuilds them
      // from the one imported document, and a document produced by our own
      // `exportAll` is always internally consistent — resumes and jobs are
      // read from the same store snapshot, so no job in it can reference a
      // resume missing from that same snapshot. Only merge can graft an
      // incoming job onto a resumeId absent from both the existing library
      // and the imported file.
      await refresh();
      return counts;
    },
    [refresh],
  );

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
    importBackup,
    refresh,
  };
}

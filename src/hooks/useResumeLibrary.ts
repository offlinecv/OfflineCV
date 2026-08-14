// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useResumeLibrary — UI-facing state over the resume-library domain layer
 * (#322). Owns the reactive list, the storage-persistence signal, and the
 * approximate space-used figure; delegates all persistence to
 * `src/lib/resume-library.ts` and `src/lib/storage`. Mutations refresh the list
 * so the picker stays in sync without the caller re-fetching — except a save
 * that provably moved no listed field, which skips it (see
 * {@link saveChangesNothingListed}).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listLibrary,
  saveResumeToLibrary,
  loadResumeFromLibrary,
  renameLibraryResume,
  removeLibraryResume,
  estimateStorageUsage,
  type ResumeLibraryEntry,
  type LoadedResume,
  type SaveResumeToLibraryInput,
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
import { useLibraryChanges } from "./useLibraryChanges.ts";

/** Alias, not a copy: this hook adds nothing to what the domain layer takes, and
 *  a hand-maintained second declaration of the same six-plus fields is how a new
 *  one (`bytesUnchanged`, #824) reaches `saveResumeToLibrary` from nowhere. */
export type SaveResumeParams = SaveResumeToLibraryInput;

/**
 * Does this save change anything the picker can SEE?
 *
 * `save()` refreshes the whole list after every write — `listLibrary()` plus
 * `estimateStorageUsage()`, both round-tripping IndexedDB — which is the right
 * cost for a button click and the wrong one for a debounced autosave firing
 * behind every edit (#824). It is only worth paying when a field
 * `ResumeLibraryEntry` carries actually moved.
 *
 * Every listed field is compared except `savedAt`, which is the record's
 * `updatedAt` and therefore changes on EVERY save — comparing it would make
 * this function constantly false and the skip dead. Leaving it stale is the
 * deliberate trade, and the window it opens is real but narrow and cosmetic:
 * the timestamp is rendered only on `/`'s landing view, which is unmounted for
 * the whole of the `done` phase these saves fire in, but `reset()` ("Try
 * another file") returns to that view in the same page lifetime with no refresh
 * in between. With two or more records, a user who edits the older one and then
 * resets sees it still carrying its previous timestamp, and still sorted by it.
 * It self-corrects on the next real refresh — a mount, a rename, a delete,
 * another tab's write — and the alternative is paying two IndexedDB round trips
 * per debounce window on every edit to keep a relative time label fresh on a
 * screen nobody is looking at.
 *
 * A save with no `id`, or an `id` this list has never seen, is a NEW row and
 * always refreshes. Pure and exported so the skip is testable without a
 * database.
 */
export function saveChangesNothingListed(
  entries: readonly ResumeLibraryEntry[],
  params: SaveResumeParams,
): boolean {
  if (params.id === undefined) return false;
  const entry = entries.find((e) => e.id === params.id);
  if (entry === undefined) return false;
  return (
    entry.filename === params.filename &&
    entry.scoreOverall === params.score.overall &&
    entry.sourceKind === params.sourceKind &&
    // Every save from here writes a readable snapshot, so a `false` here is a
    // record that HAD none and is gaining one — a visible change (#757).
    entry.hasCachedParse
  );
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
  /** Message from the most recent failed `load()`, or null. A fresh `load()`
   *  call clears it before attempting, so a stale error never outlives the
   *  failure that produced it — see {@link load}. The caller (`App.tsx`) is
   *  responsible for setting it when `load()` resolves `undefined`; this hook
   *  only owns the channel and its clearing. */
  loadError: string | null;
  setLoadError: (message: string | null) => void;
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
  const [loadError, setLoadError] = useState<string | null>(null);

  // The list as `save()` needs to read it: latest-value, and WITHOUT putting
  // `entries` in that callback's dep array. `save` is a dep of the autosave
  // debounce effect (#824); a `save` identity that changed on every refresh
  // would restart the timer on library churn the user did not cause, and a
  // busy-enough library could starve the write it is meant to schedule.
  const entriesRef = useRef<ResumeLibraryEntry[]>([]);

  const refresh = useCallback(async () => {
    const [list, usage] = await Promise.all([
      listLibrary(),
      estimateStorageUsage(),
    ]);
    entriesRef.current = list;
    setEntries(list);
    setUsageBytes(usage);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    void isStoragePersisted().then(setPersisted);
  }, [refresh]);

  // Re-read on a `resumes` write this hook did not itself make (#760) —
  // another tab, a restored backup, an out-of-tree producer writing through
  // `putRecord`. Own mutations below already call `refresh()` directly and
  // never trigger this (`onLibraryChange` never delivers a tab's own post).
  useLibraryChanges("resumes", refresh);

  // At most one `navigator.storage.persist()` per mount. This used to sit
  // inline in `save()`, which was fine while the only caller was a button —
  // #824 made the caller a debounced autosave, so a per-write request fires on
  // the first inline edit and again every quiet period. Firefox answers
  // `persist()` with a user-visible "Allow … to store data in persistent
  // storage?" doorhanger, and a permission prompt the user clicked nothing to
  // trigger, repeatedly, is not what #322 asked for. The intent it DID ask for
  // — ask when the user actually commits something to disk, never on a visit
  // that stores nothing — is unchanged: this still runs from the first write
  // and never before it.
  const persistenceAsked = useRef(false);

  const askForPersistenceOnce = useCallback(async () => {
    if (persistenceAsked.current) return;
    // Set before the await so two writes racing the first one cannot both ask.
    persistenceAsked.current = true;
    const granted = await requestStoragePersistence();
    // Reflect the grant so the UI can drop the eviction warning.
    setPersisted((prev) => prev || granted);
  }, []);

  const save = useCallback(
    async (params: SaveResumeParams) => {
      await askForPersistenceOnce();
      const id = await saveResumeToLibrary(params);
      // Read the list BEFORE the write for the skip decision — the comparison is
      // "did this save change a listed field", and post-write the answer is
      // always no. `entriesRef` is only advanced by `refresh()`, so it still
      // holds the pre-write list here.
      if (!saveChangesNothingListed(entriesRef.current, params)) {
        await refresh();
      }
      return id;
    },
    [askForPersistenceOnce, refresh],
  );

  const load = useCallback((id: string) => {
    // A fresh attempt supersedes whatever the last one left behind — clearing
    // here (rather than only on success) covers both "a new attempt" and "a
    // successful load" in one place: on success nothing re-sets it, so it
    // stays cleared; on failure `App.tsx` sets it after this resolves.
    setLoadError(null);
    return loadResumeFromLibrary(id);
  }, []);

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
    loadError,
    setLoadError,
    rename,
    remove,
    exportBackup,
    importBackup,
    refresh,
  };
}

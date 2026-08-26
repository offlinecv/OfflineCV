// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Local-first storage foundation (#321) — public surface.
 *
 * Typed CRUD over an IndexedDB database with four record stores (`resumes`,
 * `jobs`, `boards`, `letters`) plus the `sync` bookmarks that describe three of
 * them, durability control, and a JSON export/import backup path.
 * Infrastructure only: the resume-library and job-tracker UIs build on this.
 * Product code imports from `../lib/storage` (the barrel), not the internal
 * files — tests may reach past it to exercise a layer directly.
 *
 * Two admission rules, and they are what keep that first sentence true:
 *
 *  - A name earns a slot by having a consumer outside this directory, or by
 *    being registered in `.fallowrc.jsonc` as intended external API (the job
 *    capture contract and the cover-letter contract below, both normative for
 *    third-party producers per `docs/job-capture-contract.md` and
 *    `docs/cover-letter-contract.md`). The vocabulary the module only talks to
 *    itself in — `StoredRecord`, `ResumeRecord`, `SaveResumeInput`,
 *    `ExportedResume`, `StorageExport`, `LETTER_RECORD_RULES`,
 *    `RESUME_RECORD_RULES`/`validateResumeRecord` (#757 — unlike the job and
 *    letter contracts, there is no third-party résumé producer doc to be
 *    normative for; only `backup.ts` calls it), and the
 *    `exportAll`/`exportToJson`/`importAll` primitives under
 *    {@link downloadStorageBackup} and {@link importFromJson} — is deliberately
 *    absent. `postLibraryChange` and its batching seam (`runBatchedWrites`)
 *    are absent for the same reason: `crud.ts` is the only poster, and
 *    `backup.ts` and `jobs.ts` (#759) are the only batchers — both live
 *    inside this directory and reach `runBatchedWrites` directly, so nothing
 *    outside it needs the seam itself.
 *
 *    `SkippedResume` (#757) and `LibraryChangeMessage` (#760) are the two most
 *    recent applications of that rule, and both are worth naming because their
 *    siblings DID earn slots: `SkippedJob` has a consumer
 *    (`ResumeLibraryImportDialog`) and `SkippedLetter` is registered in
 *    `.fallowrc.jsonc` against `docs/cover-letter-contract.md`. `SkippedResume`
 *    has neither — no surface renders a refused résumé yet — so it stays on
 *    `backup.ts`, where {@link ImportCounts} needs it. `LibraryChangeMessage`
 *    never had a caller in a position to name it, since {@link onLibraryChange}
 *    hands its subscriber a bare `StoreName` and never the message; it is
 *    module-local in `library-channel.ts` rather than re-exported here.
 *  - Conversely, a name a consumer needs belongs here. Withholding one is what
 *    produced the deep imports of `./types.ts` this barrel exists to prevent:
 *    `JobStatus` and `JOB_STATUS_ORDER` were reachable no other way.
 *    `StoreName` joined for the same reason (#760): `useLibraryChanges`
 *    (`src/hooks/`) has to name the store it's subscribing to.
 *
 * The standing exceptions are `src/lib/job-search/board-cache.ts` and
 * `src/lib/job-search/watched-companies.ts` (#864), which reach `./crud.ts`
 * directly for the generic `getRecord`/`putRecord`/`getAllRecords`/
 * `deleteRecord` accessors. Neither has a domain module here to wrap it — a
 * `boards.ts` or `watched.ts` would exist for exactly one job-search caller
 * each — and routing either through this barrel would pull `backup.ts` +
 * `resumes.ts` into the job-search chunk for a couple of functions.
 */

export { DB_NAME, closeDB } from "./db.ts";
export {
  saveResume,
  getResume,
  getAllResumes,
  deleteResume,
  listResumeChoices,
  type ResumeChoice,
} from "./resumes.ts";
export { saveJob, getJob, getAllJobs, deleteJob, archiveJobs } from "./jobs.ts";
export {
  saveLetter,
  getLetter,
  getAllLetters,
  lettersForJob,
  deleteLetter,
  clearLetterResumeLink,
} from "./letters.ts";
export {
  requestStoragePersistence,
  isStoragePersisted,
  EVICTION_NOTICE,
} from "./persist.ts";
export {
  importFromJson,
  downloadStorageBackup,
  type ImportCounts,
  type SkippedJob,
  type SkippedLetter,
} from "./backup.ts";
export {
  findJsonSafetyProblem,
  type JsonSafetyProblem,
} from "./record-contract.ts";
export {
  validateJobRecord,
  isKnownStatus,
  JOB_CAPTURE_CONTRACT_VERSION,
  JOB_RECORD_RULES,
  type JobRecordValidation,
  type JobRecordIssue,
} from "./job-record-contract.ts";
export {
  validateLetterRecord,
  LETTER_CONTRACT_VERSION,
  type LetterRecordValidation,
} from "./letter-contract.ts";
export {
  canonicalJobUrl,
  dedupeCanonicalUrls,
  deriveJobId,
  isAbsoluteUrl,
  isCapturableJobUrl,
  JOB_URL_ID_PREFIX,
  JOB_URL_TRACKING_PARAMS,
  JOB_URL_TRACKING_PARAM_PREFIXES,
} from "./job-url.ts";
export { captureJob, type JobCaptureResult } from "./capture.ts";
/**
 * The replication surface (#730). No consumer inside this repo — the reader is
 * the browser extension, which builds these modules from a pinned commit and
 * therefore cannot define an object store, an index, or a record shape of its
 * own. Every name here exists because the alternative is that consumer
 * re-deriving this repo's schema against a store it does not own, which is the
 * second-definition failure `job-record-contract.ts` documents at length.
 *
 * `softDeleteRecord` is deliberately NOT exported: deleting a job is
 * {@link deleteJob}'s job, cascade and all, and a second door onto the same
 * action is how a caller ends up tombstoning a job and orphaning its letters.
 */
export { isLive, listRecordsUpdatedSince } from "./crud.ts";
export { getSyncCursor, setSyncCursor } from "./sync-cursor.ts";
export { JOB_STATUS_ORDER } from "./types.ts";
export type {
  JobRecord,
  JobStatus,
  JobOrigin,
  JobCaptureProvenance,
  LetterRecord,
  LetterProvenance,
  SyncableStoreName,
  SyncCursorRecord,
  StoreName,
} from "./types.ts";
/**
 * Same-origin change signal (#760) — `useJobTracker`/`useResumeLibrary`
 * subscribe through `useLibraryChanges` (`src/hooks/`) so an open tab
 * re-reads after a write made anywhere else: another tab, a restored backup,
 * an out-of-tree producer writing through `putRecord`. `postLibraryChange`
 * and the batching seam it rides on stay internal to this directory —
 * `crud.ts` is the only poster; see `library-channel.ts`.
 */
export { onLibraryChange } from "./library-channel.ts";

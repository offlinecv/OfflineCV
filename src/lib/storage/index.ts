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
 *    itself in — `StoredRecord`, `StoreName`, `ResumeRecord`, `SaveResumeInput`,
 *    `ExportedResume`, `StorageExport`, `LETTER_RECORD_RULES`, and the
 *    `exportAll`/`exportToJson`/`importAll` primitives under
 *    {@link downloadStorageBackup} and {@link importFromJson} — is deliberately
 *    absent.
 *  - Conversely, a name a consumer needs belongs here. Withholding one is what
 *    produced the deep imports of `./types.ts` this barrel exists to prevent:
 *    `JobStatus` and `JOB_STATUS_ORDER` were reachable no other way.
 *
 * The one standing exception is `src/lib/job-search/board-cache.ts`, which
 * reaches `./crud.ts` for the generic `getRecord`/`putRecord` accessors. There
 * is no `boards.ts` domain module to wrap them, and routing it here would pull
 * `backup.ts` + `resumes.ts` into the job-search chunk for two functions.
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
export { saveJob, getJob, getAllJobs, deleteJob } from "./jobs.ts";
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
  JobCaptureProvenance,
  LetterRecord,
  LetterProvenance,
  SyncableStoreName,
  SyncCursorRecord,
} from "./types.ts";

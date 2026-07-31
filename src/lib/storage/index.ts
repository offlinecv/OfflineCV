// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Local-first storage foundation (#321) — public surface.
 *
 * Typed CRUD over an IndexedDB database with two stores (`resumes`, `jobs`),
 * durability control, and a JSON export/import backup path. Infrastructure only:
 * the resume-library and job-tracker UIs build on this. Import from
 * `../lib/storage` (the barrel), not the internal files.
 */

export { DB_NAME, closeDB } from "./db.ts";
export {
  saveResume,
  getResume,
  getAllResumes,
  deleteResume,
  type SaveResumeInput,
} from "./resumes.ts";
export { saveJob, getJob, getAllJobs, deleteJob } from "./jobs.ts";
export {
  requestStoragePersistence,
  isStoragePersisted,
  EVICTION_NOTICE,
} from "./persist.ts";
export {
  exportAll,
  exportToJson,
  importAll,
  importFromJson,
  downloadStorageBackup,
  type ImportCounts,
  type SkippedJob,
} from "./backup.ts";
export {
  validateJobRecord,
  findJsonSafetyProblem,
  isKnownStatus,
  JOB_CAPTURE_CONTRACT_VERSION,
  JOB_RECORD_RULES,
  type JobRecordValidation,
  type JobRecordIssue,
  type JsonSafetyProblem,
} from "./job-record-contract.ts";
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
export type {
  StoredRecord,
  ResumeRecord,
  JobRecord,
  JobCaptureProvenance,
  StoreName,
  ExportedResume,
  StorageExport,
} from "./types.ts";

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Local-first storage foundation (#321) — public surface.
 *
 * Typed CRUD over an IndexedDB database with two stores (`resumes`, `jobs`),
 * durability control, and a JSON export/import backup path. Infrastructure only:
 * the resume-library and job-tracker UIs build on this. Import from
 * `../lib/storage` (the barrel), not the internal files.
 */

export { DB_NAME, DB_VERSION, closeDB } from "./db.ts";
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
} from "./backup.ts";
export type {
  StoredRecord,
  ResumeRecord,
  JobRecord,
  StoreName,
  ExportedResume,
  StorageExport,
} from "./types.ts";

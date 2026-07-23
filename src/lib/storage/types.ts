// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Local-first storage — record shapes for the IndexedDB foundation (#321).
 *
 * Infrastructure only: the resume-library and job-tracker UIs (follow-ups) build
 * on these. The module is deliberately decoupled from parser types — a cached
 * parse rides along as an opaque `parse` payload so `src/lib/storage/` never
 * imports the heuristics graph. Callers that want the cached parse to survive
 * export/import (which is JSON, see backup.ts) should store a JSON-safe value.
 */

/** Fields every stored record carries — the generic CRUD keys on these. */
export interface StoredRecord {
  /** Stable primary key (keyPath). Generated with `crypto.randomUUID()` when a
   *  caller doesn't supply one. */
  id: string;
  /** Epoch ms of first write. Set once, preserved across updates. */
  createdAt: number;
  /** Epoch ms of the most recent write. */
  updatedAt: number;
}

/** A saved resume: raw PDF bytes as a `Blob` (no base64 inflation at rest) plus
 *  a cached parse so reloading it doesn't re-run the cascade. */
export interface ResumeRecord extends StoredRecord {
  filename: string;
  /** Raw source bytes. Stored via IndexedDB structured clone — no base64 until
   *  export. */
  blob: Blob;
  /** Cached parse result (e.g. a `CascadeResult`). Opaque here by design; see
   *  the module note. Absent until a parse is cached. */
  parse?: unknown;
}

/** A tracked job. Shape is owned by the job-tracker follow-up; the store exists
 *  here so both stores version together under one migration path. Kept open
 *  beyond the common keys until that issue pins the fields. */
export interface JobRecord extends StoredRecord {
  [field: string]: unknown;
}

/** A cached company ATS board: the light-index postings one board returned,
 *  keyed `${ats}:${slug}` (#533). A pure CACHE — deliberately absent from the
 *  backup document, because re-fetching a board is cheap and a stale export
 *  would resurrect boards the registry has since dropped. `postings` is opaque
 *  here for the same reason `ResumeRecord.parse` is: this module never imports
 *  the job-search graph. */
export interface BoardCacheRecord extends StoredRecord {
  postings: unknown[];
}

/** Object-store names. Adding a store is a schema-version bump (see db.ts). */
export type StoreName = "resumes" | "jobs" | "boards";

/** A resume as it appears in an export file: blob replaced by base64 + MIME so
 *  the whole backup is a single JSON document. */
export interface ExportedResume extends Omit<ResumeRecord, "blob"> {
  blobBase64: string;
  blobType: string;
}

/** The full export document (see backup.ts). `version` tracks the export
 *  format, independent of the IndexedDB schema version. */
export interface StorageExport {
  version: 1;
  exportedAt: number;
  resumes: ExportedResume[];
  jobs: JobRecord[];
}

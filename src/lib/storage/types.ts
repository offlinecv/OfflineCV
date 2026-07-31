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

/**
 * Application status of a tracked job. A simple linear lifecycle
 * (`interested → applied → interviewing → offer / rejected / archived`) — a
 * status picker, not a workflow engine (#323).
 */
export type JobStatus =
  | "interested"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "archived";

/**
 * Where a job record came from, when it came from outside this app (#693).
 *
 * Absent on every record this app writes itself — an absent value means
 * "offlinecv, contract version 1". Present on a captured record, and the reason
 * it exists at all is that a producer version cannot be retrofitted: once a
 * third-party extension is writing records, a record with no version is
 * indistinguishable from one written before the field existed.
 *
 * Deliberately NOT `StorageExport.version`: that numbers the backup DOCUMENT
 * format, and a record outlives the file it arrived in.
 */
export interface JobCaptureProvenance {
  /** The capture-contract version this producer targeted
   *  (`JOB_CAPTURE_CONTRACT_VERSION`). */
  contract: number;
  /** Free-text producer id, e.g. `"offlinecv-extension"`. */
  producer?: string;
  /** The producer's own release version. */
  producerVersion?: string;
  /** Epoch ms the producer captured the posting, which is not necessarily when
   *  the record was written here. */
  capturedAt?: number;
}

/** A tracked job (#323). Field shape pinned here now that the tracker UI exists;
 *  the store has lived in the foundation (#321) so both stores version together
 *  under one migration path. Every field is JSON-safe so the whole record
 *  survives the export/import round-trip (see backup.ts).
 *
 *  Since #693 this is a PUBLIC capture contract, not just an internal type:
 *  records arrive from a picked backup file and from producers outside this
 *  build. Adding a field here obliges you to add a rule for it in
 *  `job-record-contract.ts` (the mapped type there will not compile otherwise)
 *  and to describe it in `docs/job-capture-contract.md`. */
export interface JobRecord extends StoredRecord {
  /** Posting title, e.g. "Senior Frontend Engineer". */
  title: string;
  /** Hiring company. May be empty when the user hasn't filled it in yet. */
  company: string;
  /** Posting URL. Optional — the user pastes/types details, the record arrives
   *  via a restored backup import (see backup.ts), or a producer captured the
   *  posting it was viewing (see capture.ts); we never scrape. Must be an
   *  absolute `http`/`https` URL when it comes from outside this build: the
   *  tracker renders it straight into an anchor's `href`. It is also the input
   *  to id derivation, so two captures of one posting converge — see
   *  `job-url.ts`. */
  url?: string;
  /** Free-text notes. */
  notes?: string;
  /** Where this job sits in the application lifecycle. */
  status: JobStatus;
  /** Optional link to a saved resume (`ResumeRecord.id`) — the version used for
   *  this job. Cleared (not orphaned) if that resume is later deleted. */
  resumeId?: string;
  /** Optional pasted job description, when the job came from / ran a JD match. */
  jdText?: string;
  /** Optional JD-match result carried over from the JD-fit flow. Opaque +
   *  JSON-safe by contract so it survives export/import — enforced at the
   *  external boundary by `findJsonSafetyProblem` (#693). */
  matchResult?: unknown;
  /** Provenance for a record written by a producer outside this build (#693).
   *  Absent for every record this app creates. */
  capture?: JobCaptureProvenance;
}

/** The lifecycle order for display grouping and the "advance status" affordance
 *  (#323). Terminal branches (`offer` / `rejected` / `archived`) all sit at the
 *  end; there is no forced single path between them. */
export const JOB_STATUS_ORDER: readonly JobStatus[] = [
  "interested",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "archived",
];

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

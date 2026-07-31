// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Export / import (#321) — the user's own backup path and the mitigation for
 * browser eviction. Everything round-trips through a single JSON document:
 * resume blobs are base64-encoded (the only place bytes inflate), job records
 * pass through as-is. Import restores byte-identical blobs.
 *
 * Base64 goes through `btoa`/`atob` over a binary string so it works the same in
 * the browser and the Node test env (no `Buffer` dependency). Blobs are read via
 * `arrayBuffer()`, so encode/import are async.
 */

import { getAllRecords, putRecord, clearStore } from "./crud.ts";
import { validateJobRecord } from "./job-record-contract.ts";
import type {
  ResumeRecord,
  JobRecord,
  ExportedResume,
  StorageExport,
} from "./types.ts";

/** One job a restore refused, named well enough for the user to find it in the
 *  file. `id` / `title` are best-effort: the record failed validation, so they
 *  are read defensively and may be absent. */
export interface SkippedJob {
  id?: string;
  title?: string;
  /** Every reason the record failed, joined into one sentence. */
  reason: string;
}

/** What a restore did. `jobs` counts records actually WRITTEN, so it and
 *  `skippedJobs.length` together account for every job in the file. */
export interface ImportCounts {
  resumes: number;
  jobs: number;
  skippedJobs: SkippedJob[];
}

function describeCandidate(value: unknown): Pick<SkippedJob, "id" | "title"> {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Serialize every store to one JSON-ready document (blobs → base64). */
export async function exportAll(): Promise<StorageExport> {
  const resumes = await getAllRecords<ResumeRecord>("resumes");
  const jobs = await getAllRecords<JobRecord>("jobs");

  const exportedResumes: ExportedResume[] = await Promise.all(
    resumes.map(async ({ blob, ...rest }) => ({
      ...rest,
      blobBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      blobType: blob.type,
    })),
  );

  return {
    version: 1,
    exportedAt: Date.now(),
    resumes: exportedResumes,
    jobs,
  };
}

/** Serialize the export document to a JSON string, ready for a file download. */
export async function exportToJson(): Promise<string> {
  return JSON.stringify(await exportAll());
}

/**
 * Restore records from an export document. In `replace` mode (default) each
 * store is wiped first; otherwise records are merged (upsert by id). Resume
 * blobs are rebuilt byte-identically from base64.
 *
 * Every job is put through the capture contract (#693) BEFORE any store is
 * touched — the file is the boundary at which `JobRecord` stops being a type
 * TypeScript can vouch for. Three things follow from where that check sits:
 *
 *  - **Skip the record, not the document.** One malformed job must not cost the
 *    user the other forty, and it must not cost them their resumes.
 *  - **Never abort mid-write.** In `replace` mode the stores are already empty
 *    by the time records are written, so throwing partway through would leave
 *    the user with less than they started with. Validating up front makes that
 *    unreachable.
 *  - **Report it.** A silently-dropped record is the real failure mode here, so
 *    the skips ride back on {@link ImportCounts} and `ResumeLibrary` announces
 *    them in its `aria-live` region.
 */
export async function importAll(
  data: StorageExport,
  mode: "replace" | "merge" = "replace",
): Promise<ImportCounts> {
  if (data.version !== 1) {
    throw new Error(`Unsupported storage export version: ${data.version}`);
  }

  const accepted: JobRecord[] = [];
  const skippedJobs: SkippedJob[] = [];
  for (const job of data.jobs) {
    const validation = validateJobRecord(job);
    if (validation.ok) accepted.push(validation.record);
    else {
      skippedJobs.push({
        ...describeCandidate(job),
        reason: validation.reasons.join(" "),
      });
    }
  }

  if (mode === "replace") {
    await clearStore("resumes");
    await clearStore("jobs");
  }

  for (const { blobBase64, blobType, ...rest } of data.resumes) {
    const blob = new Blob([base64ToBytes(blobBase64)], { type: blobType });
    await putRecord<ResumeRecord>("resumes", { ...rest, blob });
  }
  for (const job of accepted) {
    await putRecord<JobRecord>("jobs", job);
  }

  return { resumes: data.resumes.length, jobs: accepted.length, skippedJobs };
}

/** Narrows `value` to `StorageExport`, or throws a readable message — never a
 *  raw `TypeError`/`SyntaxError` — so a wrong-file pick surfaces in place
 *  instead of crashing mid-import. Checked BEFORE `importAll` runs, so a
 *  malformed file is rejected before `replace` mode's `clearStore` calls, and
 *  storage is left byte-for-byte unchanged. A present-but-wrong `version`
 *  gets `importAll`'s own "Unsupported storage export version" message, so
 *  the two validation paths (typed caller vs. JSON file) read the same. */
function assertStorageExport(value: unknown): asserts value is StorageExport {
  if (value === null || typeof value !== "object") {
    throw new Error("Not an offlinecv backup file.");
  }
  const v = value as Partial<StorageExport>;
  if (!Array.isArray(v.resumes) || !Array.isArray(v.jobs)) {
    throw new Error("Not an offlinecv backup file.");
  }
  if (v.version !== 1) {
    throw new Error(`Unsupported storage export version: ${String(v.version)}`);
  }
}

/** Parse + import a JSON export string. Rejects a non-JSON file and a
 *  well-formed-JSON-but-not-a-backup file with a readable message before any
 *  store is touched — see {@link assertStorageExport}. */
export async function importFromJson(
  json: string,
  mode: "replace" | "merge" = "replace",
): Promise<ImportCounts> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  assertStorageExport(parsed);
  return importAll(parsed, mode);
}

/** Filename every backup download uses. Module-private: both surfaces reach it
 *  through {@link downloadStorageBackup}, so there is nothing to export. */
const BACKUP_FILENAME = "offlinecv-backup.json";

/**
 * Export everything and hand the user a JSON file.
 *
 * Shared by both local-first surfaces (`useResumeLibrary`, `useJobTracker`) —
 * the export is origin-wide, not per-lane, so the two "Export backup" buttons
 * produce the same document and there is no per-lane variant to justify two
 * copies of the object-URL dance.
 *
 * Browser-only (touches `URL` and `document`); callers are hooks, never lib.
 */
export async function downloadStorageBackup(): Promise<void> {
  const json = await exportToJson();
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = BACKUP_FILENAME;
    a.click();
  } finally {
    // In a `finally` so a click that throws can't leak the object URL.
    URL.revokeObjectURL(url);
  }
}

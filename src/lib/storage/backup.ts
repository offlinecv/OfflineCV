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
import type {
  ResumeRecord,
  JobRecord,
  ExportedResume,
  StorageExport,
} from "./types.ts";

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

/** Restore records from an export document. In `replace` mode (default) each
 *  store is wiped first; otherwise records are merged (upsert by id). Resume
 *  blobs are rebuilt byte-identically from base64. */
export async function importAll(
  data: StorageExport,
  mode: "replace" | "merge" = "replace",
): Promise<{ resumes: number; jobs: number }> {
  if (data.version !== 1) {
    throw new Error(`Unsupported storage export version: ${data.version}`);
  }
  if (mode === "replace") {
    await clearStore("resumes");
    await clearStore("jobs");
  }

  for (const { blobBase64, blobType, ...rest } of data.resumes) {
    const blob = new Blob([base64ToBytes(blobBase64)], { type: blobType });
    await putRecord<ResumeRecord>("resumes", { ...rest, blob });
  }
  for (const job of data.jobs) {
    await putRecord<JobRecord>("jobs", job);
  }

  return { resumes: data.resumes.length, jobs: data.jobs.length };
}

/** Parse + import a JSON export string. */
export async function importFromJson(
  json: string,
  mode: "replace" | "merge" = "replace",
): Promise<{ resumes: number; jobs: number }> {
  return importAll(JSON.parse(json) as StorageExport, mode);
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

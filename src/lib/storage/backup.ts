// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Export / import (#321) — the user's own backup path and the mitigation for
 * browser eviction. Everything round-trips through a single JSON document:
 * resume blobs are base64-encoded (the only place bytes inflate), job and
 * letter records pass through as-is. Import restores byte-identical blobs.
 *
 * The document is versioned separately from the IndexedDB schema. It is at
 * **2** since the letters store landed (#711); a **1** document, which has no
 * `letters` key at all, must import forever — a backup on a user's disk does
 * not upgrade itself.
 *
 * ## Tombstones ARE exported (#730)
 *
 * A deleted job or letter rides into the file carrying its `deletedAt`, and
 * imports back as deleted. The decision is not obvious, so here is the whole
 * of it.
 *
 * Omitting them looks tidier and is wrong in `merge` mode, which is the mode
 * that exists precisely to combine two copies of a library. Device A deletes a
 * job and exports; device B still has it live; B's file merged into A would
 * hand the job straight back, because a record that is simply missing from a
 * file is indistinguishable from one the file's author never had. The deletion
 * silently undoes itself, and the user has no way to tell which of their two
 * devices is right. Carrying the tombstone makes the file state a fact instead
 * of an absence, so the merge converges.
 *
 * In `replace` mode the visible result is identical either way — the stores are
 * wiped first, so an omitted record and a tombstoned one both end up
 * unrendered. Exporting them costs a few bytes there and buys correctness in
 * the other mode, which is why the tie breaks this way.
 *
 * It follows that the document is not a list of what the user has; it is the
 * state of the store, deletions included. Two consequences worth stating: an
 * export→import→export cycle is stable rather than quietly shedding rows, and
 * {@link ImportCounts} therefore reports LIVE records, because "restored 40
 * jobs" must mean forty the user can see.
 *
 * The `sync` store is the counter-example that shows where the line is: it is
 * also part of the database and it is deliberately absent, because a cursor
 * describes what one device has exchanged. Restoring it onto a second device
 * would tell that device it had already pulled records it has never seen.
 *
 * Base64 goes through `btoa`/`atob` over a binary string so it works the same in
 * the browser and the Node test env (no `Buffer` dependency). Blobs are read via
 * `arrayBuffer()`, so encode/import are async.
 */

import { getAllRecords, putRecord, clearStore, isLive } from "./crud.ts";
import { validateJobRecord } from "./job-record-contract.ts";
import { validateLetterRecord } from "./letter-contract.ts";
import type {
  ResumeRecord,
  JobRecord,
  LetterRecord,
  ExportedResume,
  StorageExport,
  StorageExportV2,
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

/** One letter a restore refused. Sibling of {@link SkippedJob}; `label` rather
 *  than `title` because that is the letter's own user-facing name. */
export interface SkippedLetter {
  id?: string;
  label?: string;
  /** Every reason the record failed, joined into one sentence. */
  reason: string;
}

/** What a restore did. `jobs` / `letters` count the records a user can now SEE:
 *  written, and not tombstoned (#730). A file's tombstones are written too —
 *  that is the point of exporting them — but counting them would tell the user
 *  a restore brought back jobs that stay invisible, which reads as a bug in the
 *  restore rather than as the deletions it faithfully reproduced.
 *
 *  So the three numbers no longer sum to the file's record count. The
 *  `skipped…` lists still account for every record the contract REFUSED, which
 *  is the thing a user can act on; a tombstone was accepted, it just isn't
 *  something to celebrate having restored.
 *
 *  Nothing renders `skippedLetters` yet — #711 ships the store with no UI at
 *  all. It is reported from the first commit anyway because the alternative is
 *  a restore that drops a letter and says nothing, and a counter added later
 *  cannot recover the ones already dropped. */
export interface ImportCounts {
  resumes: number;
  jobs: number;
  skippedJobs: SkippedJob[];
  letters: number;
  skippedLetters: SkippedLetter[];
}

/** Read one string field off a candidate that failed validation — so `id` /
 *  `title` / `label` can be reported without trusting the record's shape. */
function readStringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
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

/** Serialize every store to one JSON-ready document (blobs → base64). Always
 *  writes the current format; see {@link importAll} for what still reads. */
export async function exportAll(): Promise<StorageExportV2> {
  // `resumes` hard-deletes, so there is nothing tombstoned to ask for.
  const resumes = await getAllRecords<ResumeRecord>("resumes");
  // Jobs and letters carry their TOMBSTONES into the file (#730) — see the
  // module docblock for why a backup records deletions rather than omitting
  // them.
  const jobs = await getAllRecords<JobRecord>("jobs", { includeDeleted: true });
  // Every `LetterRecord` field is JSON-safe by contract, so letters ride
  // through with no encode step — unlike resumes, which carry a `Blob`.
  const letters = await getAllRecords<LetterRecord>("letters", {
    includeDeleted: true,
  });

  const exportedResumes: ExportedResume[] = await Promise.all(
    resumes.map(async ({ blob, ...rest }) => ({
      ...rest,
      blobBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      blobType: blob.type,
    })),
  );

  return {
    version: 2,
    exportedAt: Date.now(),
    resumes: exportedResumes,
    jobs,
    letters,
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
 * Both a v1 and a v2 document import: a v1 file simply has no letters. That
 * back-compat is not a courtesy — an exported backup lives on the user's disk
 * and never learns about a format bump.
 *
 * Every job is put through the capture contract (#693), and every letter
 * through the letter contract (#711), BEFORE any store is touched — the file is
 * the boundary at which `JobRecord` / `LetterRecord` stop being types
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
 *    them in its `aria-live` region. Skipped LETTERS ride back too but are not
 *    announced yet — there is no letters surface to announce them next to. The
 *    counter still lands now, because one added later cannot recover the
 *    records already dropped in silence.
 */
export async function importAll(
  data: StorageExport,
  mode: "replace" | "merge" = "replace",
): Promise<ImportCounts> {
  // Widened to `number` so the guard survives the union narrowing: with
  // `data.version` typed `1 | 2`, TypeScript would narrow the failing branch to
  // `never` and the message could not read the value it is reporting. The check
  // has to run at runtime regardless — the caller may be a JSON file.
  const version: number = data.version;
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported storage export version: ${version}`);
  }

  // A v1 document predates the letters store (#711) and carries no `letters`
  // key at all. An empty list — not a refusal, and not an error — is what makes
  // every backup a user already has on disk still restorable.
  const incomingLetters: unknown[] = data.version === 2 ? data.letters : [];

  const jobs = partitionJobs(data.jobs);
  const letters = partitionLetters(incomingLetters);

  if (mode === "replace") {
    await clearStore("resumes");
    await clearStore("jobs");
    // Cleared even when the document is v1 and therefore contributes no
    // letters. Replace means "make storage match this file", and skipping the
    // wipe would leave letters whose jobs were just deleted — orphans the
    // `deleteJob` cascade exists to make impossible.
    await clearStore("letters");
  }

  // `touch: false` throughout (#730): a restored record keeps the `updatedAt`
  // it had when the backup was taken. That timestamp describes the user's last
  // edit, and a restore is not one — stamping `now` over it collapsed the whole
  // library into a single instant, which silently reordered a tracker sorted
  // most-recently-updated-first and, since v4, would tell a replicator that
  // every record on the device had just changed. A record the file carries no
  // timestamp for still gets `now` from `putRecord`.
  for (const { blobBase64, blobType, ...rest } of data.resumes) {
    const blob = new Blob([base64ToBytes(blobBase64)], { type: blobType });
    await putRecord<ResumeRecord>("resumes", { ...rest, blob }, { touch: false });
  }
  for (const job of jobs.accepted) {
    await putRecord<JobRecord>("jobs", job, { touch: false });
  }
  for (const letter of letters.accepted) {
    await putRecord<LetterRecord>("letters", letter, { touch: false });
  }

  return {
    resumes: data.resumes.length,
    jobs: jobs.accepted.filter(isLive).length,
    skippedJobs: jobs.skipped,
    letters: letters.accepted.filter(isLive).length,
    skippedLetters: letters.skipped,
  };
}

/** Split a file's jobs into the ones the capture contract accepts and the ones
 *  it refused, with a reason each. Runs before any store is touched — see
 *  {@link importAll}. */
function partitionJobs(candidates: unknown[]): {
  accepted: JobRecord[];
  skipped: SkippedJob[];
} {
  const accepted: JobRecord[] = [];
  const skipped: SkippedJob[] = [];
  for (const candidate of candidates) {
    const validation = validateJobRecord(candidate);
    if (validation.ok) accepted.push(validation.record);
    else {
      skipped.push({
        id: readStringField(candidate, "id"),
        title: readStringField(candidate, "title"),
        reason: validation.reasons.join(" "),
      });
    }
  }
  return { accepted, skipped };
}

/** The letters half of {@link partitionJobs}. Same skip-don't-throw rule: one
 *  malformed letter must not cost the user the file's other records. */
function partitionLetters(candidates: unknown[]): {
  accepted: LetterRecord[];
  skipped: SkippedLetter[];
} {
  const accepted: LetterRecord[] = [];
  const skipped: SkippedLetter[] = [];
  for (const candidate of candidates) {
    const validation = validateLetterRecord(candidate);
    if (validation.ok) accepted.push(validation.record);
    else {
      skipped.push({
        id: readStringField(candidate, "id"),
        label: readStringField(candidate, "label"),
        reason: validation.reasons.join(" "),
      });
    }
  }
  return { accepted, skipped };
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
  // Read through a loose shape rather than `Partial<StorageExport>`: the union
  // types `version` as `1 | 2`, and comparing that against an arbitrary parsed
  // value is exactly the comparison TypeScript would call unintentional. The
  // point of this function is that nothing here is typed yet.
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.resumes) || !Array.isArray(v.jobs)) {
    throw new Error("Not an offlinecv backup file.");
  }
  if (v.version !== 1 && v.version !== 2) {
    throw new Error(`Unsupported storage export version: ${String(v.version)}`);
  }
  // A v2 document without a `letters` array is malformed, not a v1 document:
  // the version number is the file's own claim about its shape, and a file that
  // fails its own claim is the "wrong file picked" case, not a back-compat one.
  if (v.version === 2 && !Array.isArray(v.letters)) {
    throw new Error("Not an offlinecv backup file.");
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

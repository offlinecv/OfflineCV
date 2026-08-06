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

import {
  getAllRecords,
  putRecord,
  clearStore,
  isLive,
  runBatchedWrites,
} from "./crud.ts";
import { validateJobRecord } from "./job-record-contract.ts";
import { validateLetterRecord } from "./letter-contract.ts";
import { validateResumeRecord } from "./resume-record-contract.ts";
import { isPlainObject } from "./record-contract.ts";
import type {
  ResumeRecord,
  JobRecord,
  LetterRecord,
  ExportedResume,
  StorageExport,
  StorageExportV2,
} from "./types.ts";

/** One résumé a restore refused. Sibling of {@link SkippedJob}; `filename`
 *  rather than `title`/`label` because that is the résumé's own user-facing
 *  name. */
export interface SkippedResume {
  id?: string;
  filename?: string;
  /** Every reason the record failed, joined into one sentence. */
  reason: string;
}

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
 *  restore rather than as the deletions it faithfully reproduced. `resumes`
 *  counts the same way for a different reason: `resumes` hard-deletes, so
 *  there are no tombstones to exclude, but since #757 it counts records the
 *  résumé contract ACCEPTED rather than every record the file carried.
 *
 *  So the three numbers no longer sum to the file's record count. The
 *  `skipped…` lists still account for every record the contract REFUSED, which
 *  is the thing a user can act on; a tombstone was accepted, it just isn't
 *  something to celebrate having restored.
 *
 *  Nothing renders `skippedLetters` or `skippedResumes` yet — #711 and #757
 *  ship their stores with no dedicated UI for a skip list. Both are reported
 *  from the first commit anyway because the alternative is a restore that
 *  drops a record and says nothing, and a counter added later cannot recover
 *  the ones already dropped.
 *
 *  `resumesWithoutParse` is not a skip — it counts records ACCEPTED (#757)
 *  that carry no `parse` payload AT ALL. That is a legal shape (every résumé
 *  #693's capture door writes has one), and the record is loadable — it just
 *  has to be re-parsed from its stored bytes on the next `Load` (#758). Kept
 *  distinct from `skippedResumes` so "this record needs a moment to re-parse"
 *  never reads as "this record was dropped".
 *
 *  **It counts absence, not unreadability, and the two are not the same
 *  set.** `resume-library.ts#listLibrary`'s `hasCachedParse` asks the stronger
 *  question — can `readSnapshot` actually get a `result` and a `score` out of
 *  it — so a record whose `parse` is present but not readable as a snapshot
 *  is unparsed to the library and NOT counted here. That gap is deliberate
 *  rather than an oversight: the `SavedResumeSnapshot` shape belongs to
 *  `resume-library.ts` one layer up, and `resume-record-contract.ts`'s own
 *  docblock states in terms that this layer does not assert it. Closing the
 *  gap means moving that judgement down here, which contradicts that
 *  boundary, or injecting the predicate into `importAll`, which is a channel
 *  for a number nothing currently renders. Both are worse than naming the
 *  limit. Anything that starts SHOWING this count should read it off the
 *  library's predicate instead of this one. */
export interface ImportCounts {
  resumes: number;
  skippedResumes: SkippedResume[];
  resumesWithoutParse: number;
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
 * Every job is put through the capture contract (#693), every letter through
 * the letter contract (#711), and every résumé through the résumé contract
 * (#757), BEFORE any store is touched — the file is the boundary at which
 * `JobRecord` / `LetterRecord` / `ResumeRecord` stop being types TypeScript can
 * vouch for. Three things follow from where that check sits:
 *
 *  - **Skip the record, not the document.** One malformed job must not cost the
 *    user the other forty, and it must not cost them their resumes.
 *  - **Never abort mid-write.** In `replace` mode the stores are already empty
 *    by the time records are written, so throwing partway through would leave
 *    the user with less than they started with. Validating up front makes that
 *    unreachable.
 *  - **Report it.** A silently-dropped record is the real failure mode here, so
 *    the skips ride back on {@link ImportCounts} and `ResumeLibrary` announces
 *    skipped JOBS in its `aria-live` region. Skipped LETTERS and RESUMES ride
 *    back too but are not announced yet — neither has a skip-list surface to
 *    announce next to. The counters still land now, because one added later
 *    cannot recover the records already dropped in silence.
 *
 * Every write below runs inside `runBatchedWrites` (#760): a restore can be
 * hundreds of records, and without coalescing each `putRecord`/`clearStore`
 * call would post its own change signal, driving one full re-read per
 * message in every other open tab. Emit-side coalescing — one signal per
 * store touched, posted once the whole restore finishes — was chosen over a
 * debounce on the receiving hooks because the latter only reduces re-reads;
 * it cannot make the message count itself bounded, which is what a bulk
 * import has to prove (see `library-changes.test.ts`'s message-count
 * assertion).
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

  const resumes = partitionResumes(data.resumes);
  const jobs = partitionJobs(data.jobs);
  const letters = partitionLetters(incomingLetters);

  // The whole restore — the replace-mode wipe and every put below — runs in
  // one `runBatchedWrites` scope (#760), so a store that gets both cleared
  // and repopulated here still posts only the one coalesced signal, not one
  // for the clear and another for the puts.
  await runBatchedWrites(async () => {
    if (mode === "replace") {
      await clearStore("resumes");
      await clearStore("jobs");
      // Cleared even when the document is v1 and therefore contributes no
      // letters. Replace means "make storage match this file", and skipping
      // the wipe would leave letters whose jobs were just deleted — orphans
      // the `deleteJob` cascade exists to make impossible.
      await clearStore("letters");
    }

    // `touch: false` throughout (#730): a restored record keeps the
    // `updatedAt` it had when the backup was taken. That timestamp describes
    // the user's last edit, and a restore is not one — stamping `now` over it
    // collapsed the whole library into a single instant, which silently
    // reordered a tracker sorted most-recently-updated-first and, since v4,
    // would tell a replicator that every record on the device had just
    // changed. A record the file carries no timestamp for still gets `now`
    // from `putRecord`.
    for (const resume of resumes.accepted) {
      await putRecord<ResumeRecord>("resumes", resume, { touch: false });
    }
    for (const job of jobs.accepted) {
      await putRecord<JobRecord>("jobs", job, { touch: false });
    }
    for (const letter of letters.accepted) {
      await putRecord<LetterRecord>("letters", letter, { touch: false });
    }
  });

  return {
    resumes: resumes.accepted.length,
    skippedResumes: resumes.skipped,
    resumesWithoutParse: resumes.accepted.filter((r) => r.parse === undefined).length,
    jobs: jobs.accepted.filter(isLive).length,
    skippedJobs: jobs.skipped,
    letters: letters.accepted.filter(isLive).length,
    skippedLetters: letters.skipped,
  };
}

/**
 * Split a file's résumés into the ones the résumé contract accepts and the
 * ones it refused. `blobBase64`/`blobType` are not part of that contract (see
 * `resume-record-contract.ts`'s module docblock) — checked here, at the one
 * call site that decodes them, before the rest of the candidate reaches
 * {@link validateResumeRecord}. Runs before any store is touched — see
 * {@link importAll}.
 */
function partitionResumes(candidates: unknown[]): {
  accepted: ResumeRecord[];
  skipped: SkippedResume[];
} {
  const accepted: ResumeRecord[] = [];
  const skipped: SkippedResume[] = [];
  for (const candidate of candidates) {
    const blobIssue = resumeBlobFieldsIssue(candidate);
    if (blobIssue !== undefined) {
      skipped.push({
        id: readStringField(candidate, "id"),
        filename: readStringField(candidate, "filename"),
        reason: blobIssue,
      });
      continue;
    }
    // `resumeBlobFieldsIssue` above already proved `candidate` is a plain
    // object with string `blobBase64`/`blobType`.
    const { blobBase64, blobType, ...rest } = candidate as Record<string, unknown> & {
      blobBase64: string;
      blobType: string;
    };
    const validation = validateResumeRecord(rest);
    if (!validation.ok) {
      skipped.push({
        id: readStringField(candidate, "id"),
        filename: readStringField(candidate, "filename"),
        reason: validation.reasons.join(" "),
      });
      continue;
    }
    const blob = new Blob([base64ToBytes(blobBase64)], { type: blobType });
    accepted.push({ ...validation.record, blob });
  }
  return { accepted, skipped };
}

/** `blobBase64`/`blobType` are the two fields `resume-record-contract.ts`
 *  deliberately does not check (see its module docblock) — this is where they
 *  actually are. A candidate that fails this never reaches
 *  {@link validateResumeRecord} at all, since there would be no bytes to
 *  rebuild a `Blob` from even if the rest of it were valid. */
function resumeBlobFieldsIssue(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "A resume record must be a plain JSON object.";
  if (typeof value.blobBase64 !== "string") {
    return "`blobBase64` is required and must be a string.";
  }
  if (typeof value.blobType !== "string") {
    return "`blobType` is required and must be a string.";
  }
  return undefined;
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

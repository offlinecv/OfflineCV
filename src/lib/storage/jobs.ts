// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Job store — domain wrappers over the generic CRUD (#321). The record shape is
 * owned by the job-tracker follow-up; this keeps the store usable now (id +
 * timestamps managed) without pinning fields prematurely.
 */

import {
  putRecord,
  putRecordIntoExisting,
  getRecord,
  getRecordFromExisting,
  getAllRecords,
  isLive,
  softDeleteRecord,
  runBatchedWrites,
} from "./crud.ts";
import { deleteLettersForJob } from "./letters.ts";
import type { JobRecord } from "./types.ts";

/** Save a job record. Generates a UUID when `id` is absent; timestamps managed
 *  by `putRecord`. Extra fields pass through (open shape until the tracker
 *  issue pins them). `touch: false` preserves `updatedAt` for a housekeeping
 *  write the user did not make — see `putRecord`. */
export async function saveJob(
  input: Partial<JobRecord> & { id?: string },
  options: { touch?: boolean } = {},
): Promise<JobRecord> {
  return saveJobVia(putRecord, input, options);
}

/** Same as {@link saveJob}, opened via `getExistingDB()` instead (through
 *  `putRecordIntoExisting`) — what `captureJob`'s `…IntoExisting` variant
 *  calls, for a content-script consumer. */
export async function saveJobIntoExisting(
  input: Partial<JobRecord> & { id?: string },
  options: { touch?: boolean } = {},
): Promise<JobRecord> {
  return saveJobVia(putRecordIntoExisting, input, options);
}

/** The body both `saveJob` twins share, parameterized on the writer. One copy,
 *  so a later change to the id default or the write shape cannot reach one twin
 *  and miss the other — the same `…Via` seam `captureJobVia` and
 *  `putRecordVia` use. */
async function saveJobVia(
  put: typeof putRecord,
  input: Partial<JobRecord> & { id?: string },
  options: { touch?: boolean },
): Promise<JobRecord> {
  // The store is intentionally permissive — it writes whatever fields the caller
  // supplies (the domain layer in `job-tracker.ts` owns completeness). Reads are
  // typed as a full `JobRecord` because every production write goes through the
  // domain layer with the required fields set; the cast bridges the permissive
  // write shape to `putRecord`'s complete-record parameter.
  return put<JobRecord>("jobs", {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as Omit<JobRecord, "createdAt" | "updatedAt"> &
    Partial<Pick<JobRecord, "createdAt" | "updatedAt">>, options);
}

/**
 * One job by id, or undefined — **including when the job is tombstoned**
 * (#730).
 *
 * A deleted job reads as gone at this layer, so nothing built on it can leak
 * one: `getJobById` cannot render it, and `updateJob` throws rather than
 * quietly resurrecting it by writing a patch over the tombstone. The raw row is
 * still reachable through `crud.ts`'s `getRecord`, which is what replication
 * needs and what the tracker must never have.
 */
export async function getJob(id: string): Promise<JobRecord | undefined> {
  return getJobVia(getRecord, id);
}

/** Same as {@link getJob}, opened via `getExistingDB()` instead (through
 *  `getRecordFromExisting`) — what `captureJob`'s `…IntoExisting` variant
 *  calls, for a content-script consumer. */
export async function getJobFromExisting(
  id: string,
): Promise<JobRecord | undefined> {
  return getJobVia(getRecordFromExisting, id);
}

/** The liveness check both `getJob` twins share, parameterized on the reader —
 *  one definition of "a tombstoned job reads as gone", so the tombstone
 *  semantics {@link getJob}'s docblock states cannot drift between them. */
async function getJobVia(
  get: typeof getRecord,
  id: string,
): Promise<JobRecord | undefined> {
  const record = await get<JobRecord>("jobs", id);
  return record !== undefined && isLive(record) ? record : undefined;
}

/** Every live job. Tombstones are filtered by `getAllRecords`'s default. */
export function getAllJobs(): Promise<JobRecord[]> {
  return getAllRecords<JobRecord>("jobs");
}

/**
 * Delete a job and CASCADE to its cover letters (#711). Both sides are
 * TOMBSTONED rather than removed (#730) — see `StoredRecord.deletedAt`.
 *
 * The cascade lives here, at the store, rather than a layer up in
 * `job-tracker.ts`: `LetterRecord.jobId` is a required parent link, so "no
 * letter outlives its job" is referential integrity, not tracker policy, and
 * putting it behind the one door means no future caller of `deleteJob` can
 * forget it. (Contrast `clearResumeLink`, which is called from the resume-delete
 * path a layer up — that one is cross-aggregate policy about a link, not about
 * a child record's existence.)
 *
 * The job goes first. If the letter sweep then fails, the user's actual
 * intent — the job is gone — still happened; the reverse order would let a
 * failure delete the letters of a job that survives, which is data loss the
 * user did not ask for and cannot see coming.
 *
 * The cascade tombstones each letter individually rather than relying on the
 * job's own tombstone to hide them. A letter is a record in its own right: it
 * replicates on its own, and a second holder that received the letters but not
 * the job's tombstone would have no reason to stop showing them.
 */
export async function deleteJob(id: string): Promise<void> {
  await softDeleteRecord("jobs", id);
  await deleteLettersForJob(id);
}

/** Options for {@link archiveJobs}. One required member, deliberately — see
 *  that function's docblock for why the eligibility check cannot default. */
export interface ArchiveJobsOptions {
  /**
   * Re-checked against each row as it stands the instant before its write. A
   * row that answers `false` is SKIPPED, exactly as an id that has vanished
   * is, and is absent from the returned list.
   *
   * Required rather than optional, and injected rather than imported. Both
   * follow from the same two facts:
   *
   *  - **Injected**, because the only predicate that answers this question —
   *    `job-archive-sweep.ts`'s `isSweepableBucket`, via
   *    `job-status-bucket.ts` — sits a layer ABOVE `src/lib/storage/`, and
   *    `job-status-bucket.ts` imports this directory's own barrel. Importing
   *    it down here would both invert the layering (no non-test module in
   *    this directory imports from `../`) and close an import cycle
   *    `index.ts` → `jobs.ts` → `job-status-bucket.ts` → `index.ts`. Passing
   *    the predicate in keeps the store domain-agnostic, which is the whole
   *    premise of `saveJob` writing whatever fields it is handed.
   *  - **Required**, because a default would have to be "everything is still
   *    eligible", which is precisely the bug this parameter exists to close;
   *    a future caller that forgot it would silently get the unguarded loop
   *    back. The type makes forgetting impossible instead.
   *
   * It must be a check that carries no clock. See `job-archive-sweep.ts` for
   * why the sweep's AGE half is settled once, at confirm time, and never
   * re-derived here.
   */
  stillEligible: (job: JobRecord) => boolean;
}

/**
 * Set `status: "archived"` on every job in `ids`, one write each. The
 * bulk-archive sweep (#759) is this store's second per-record write loop —
 * `backup.ts`'s `importAll` is the first, and the reason `runBatchedWrites`
 * (`crud.ts`) exists at all. Without it, sweeping ~290 rows in one click
 * would post ~290 `BroadcastChannel` messages and drive ~290 full re-reads in
 * every OTHER open tab; wrapping the loop coalesces that to the one message
 * `runBatchedWrites` already guarantees per store touched.
 *
 * Sequential and awaited, not `Promise.all` or chunked — decided at #759: the
 * writes are a small, one-time, user-confirmed action, and a partial failure
 * the preview count didn't describe is worse than one that takes slightly
 * longer to finish.
 *
 * ## Why each row is re-read AND re-judged
 *
 * `ids` is a list the caller computed at some earlier moment — for the sweep,
 * when the user was shown a count and clicked Confirm. Because the loop is
 * sequential and awaited, a row near the end of a ~290-row sweep is written
 * appreciably later than that decision, and anything may have happened to it
 * in between: another tab, the browser extension writing through `putRecord`,
 * or a sync. So each id is re-read through `getJob` and then put to
 * `stillEligible` immediately before its own write:
 *
 *  - **Gone** — deleted or merged away — `getJob` returns undefined and the
 *    row is skipped, rather than a `saveJob` resurrecting a tombstone.
 *  - **No longer eligible** — someone moved it to Applied — `stillEligible`
 *    answers false and the row is skipped the same way. Without this the
 *    sweep would overwrite that Applied status with `"archived"`, breaking
 *    the guarantee `JobArchiveSweepDialog` states at the confirm step
 *    ("Applied, Interviewing, Offer, and Rejected jobs are never touched")
 *    and destroying pipeline state the user built by hand.
 *
 * This narrows the window; it does not make the write atomic. `getJob` and
 * `saveJob` are two separate IndexedDB transactions, so a writer that lands
 * between them is still unseen. What changes is the size of the exposure: it
 * goes from "the entire duration of the sweep, for every row in it" to "the
 * gap between one row's read and its own write". Closing it completely would
 * need a read-modify-write inside a single transaction, which this layer does
 * not currently expose; the residual gap is recorded here rather than papered
 * over.
 *
 * ## What the caller learns about a skip
 *
 * Nothing is added for it, on purpose. The return value is already the report:
 * skipped rows are simply absent, so `archiveInterestedOlderThan` — which
 * returns `archived.length` — hands `JobArchiveSweepDialog` the number of rows
 * actually written, and the dialog's "Archived N jobs." is true by
 * construction. Under a concurrent status change that number is now smaller
 * than the previewed count, which is the honest outcome: the alternative is
 * either reporting a count larger than the writes, or building a
 * skipped-rows channel no surface renders.
 *
 * Returns the records actually archived, in `ids` order minus any skipped.
 */
export async function archiveJobs(
  ids: readonly string[],
  options: ArchiveJobsOptions,
): Promise<JobRecord[]> {
  return runBatchedWrites(async () => {
    const archived: JobRecord[] = [];
    for (const id of ids) {
      const existing = await getJob(id);
      if (existing === undefined) continue;
      if (!options.stillEligible(existing)) continue;
      archived.push(await saveJob({ ...existing, status: "archived", id }));
    }
    return archived;
  });
}

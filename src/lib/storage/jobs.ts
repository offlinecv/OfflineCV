// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Job store — domain wrappers over the generic CRUD (#321). The record shape is
 * owned by the job-tracker follow-up; this keeps the store usable now (id +
 * timestamps managed) without pinning fields prematurely.
 */

import {
  putRecord,
  getRecord,
  getAllRecords,
  deleteRecord,
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
  // The store is intentionally permissive — it writes whatever fields the caller
  // supplies (the domain layer in `job-tracker.ts` owns completeness). Reads are
  // typed as a full `JobRecord` because every production write goes through the
  // domain layer with the required fields set; the cast bridges the permissive
  // write shape to `putRecord`'s complete-record parameter.
  return putRecord<JobRecord>("jobs", {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as Omit<JobRecord, "createdAt" | "updatedAt"> &
    Partial<Pick<JobRecord, "createdAt" | "updatedAt">>, options);
}

export function getJob(id: string): Promise<JobRecord | undefined> {
  return getRecord<JobRecord>("jobs", id);
}

export function getAllJobs(): Promise<JobRecord[]> {
  return getAllRecords<JobRecord>("jobs");
}

/**
 * Delete a job and CASCADE to its cover letters (#711).
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
 */
export async function deleteJob(id: string): Promise<void> {
  await deleteRecord("jobs", id);
  await deleteLettersForJob(id);
}

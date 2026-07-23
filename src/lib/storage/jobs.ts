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

export function deleteJob(id: string): Promise<void> {
  return deleteRecord("jobs", id);
}

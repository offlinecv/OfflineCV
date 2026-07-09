// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 *  issue pins them). */
export async function saveJob(
  input: Partial<JobRecord> & { id?: string },
): Promise<JobRecord> {
  return putRecord<JobRecord>("jobs", {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  });
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

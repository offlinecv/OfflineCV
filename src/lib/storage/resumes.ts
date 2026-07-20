// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Resume store — domain wrappers over the generic CRUD (#321). Handles id
 * generation and the "save the bytes + a cached parse" shape so callers pass a
 * `Blob` and get a stable record back.
 */

import {
  putRecord,
  getRecord,
  getAllRecords,
  deleteRecord,
} from "./crud.ts";
import type { ResumeRecord } from "./types.ts";

/** Fields a caller supplies when saving; id/timestamps are managed here. */
export interface SaveResumeInput {
  /** Provide to update an existing resume; omit to mint a new one. */
  id?: string;
  filename: string;
  blob: Blob;
  parse?: unknown;
}

/** Create or update a resume. Generates a UUID for new records; `putRecord`
 *  owns the timestamps (createdAt preserved on update, refreshed updatedAt). */
export async function saveResume(input: SaveResumeInput): Promise<ResumeRecord> {
  return putRecord<ResumeRecord>("resumes", {
    id: input.id ?? crypto.randomUUID(),
    filename: input.filename,
    blob: input.blob,
    parse: input.parse,
  });
}

export function getResume(id: string): Promise<ResumeRecord | undefined> {
  return getRecord<ResumeRecord>("resumes", id);
}

export function getAllResumes(): Promise<ResumeRecord[]> {
  return getAllRecords<ResumeRecord>("resumes");
}

export function deleteResume(id: string): Promise<void> {
  return deleteRecord("resumes", id);
}

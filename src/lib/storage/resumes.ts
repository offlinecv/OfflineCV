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
  getAllRecordsFromExisting,
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

/** Same as {@link getAllResumes}, opened via `getExistingDB()` instead — what
 *  {@link listResumeChoicesFromExisting} calls, for the browser extension's
 *  content script. Private: unlike `getAllResumes` it has no consumer outside
 *  this file, and exporting it would put a whole résumé corpus (blobs included)
 *  on a surface only the narrow `ResumeChoice` projection is meant to reach. */
function getAllResumesFromExisting(): Promise<ResumeRecord[]> {
  return getAllRecordsFromExisting<ResumeRecord>("resumes");
}

export function deleteResume(id: string): Promise<void> {
  return deleteRecord("resumes", id);
}

/** One saved resume, stripped to what a picker needs. No `blob`, no cached
 *  `parse` — see {@link listResumeChoices}. */
export interface ResumeChoice {
  id: string;
  filename: string;
  /** Epoch ms of the last save (record `updatedAt`). */
  updatedAt: number;
}

/** List saved resumes as picker choices, newest first (#712). `getAllResumes`
 *  returns whole `ResumeRecord`s, each carrying the raw PDF `blob` — fine for
 *  this app's own UI, but wasteful to structured-clone across a `postMessage`
 *  bridge (e.g. to the browser extension) just to ask "which resume?". This is
 *  the narrow, cross-origin-safe answer: id, filename, and a timestamp, and
 *  nothing that touches the resume corpus. */
export async function listResumeChoices(): Promise<ResumeChoice[]> {
  return listResumeChoicesVia(getAllResumes);
}

/** Same as {@link listResumeChoices}, opened via `getExistingDB()` instead —
 *  the variant `@offlinecv/core` re-exports as `listResumeChoices` to a
 *  content-script consumer; see `db.ts`'s `getExistingDB` docblock for why. */
export async function listResumeChoicesFromExisting(): Promise<ResumeChoice[]> {
  return listResumeChoicesVia(getAllResumesFromExisting);
}

async function listResumeChoicesVia(
  getAll: typeof getAllResumes,
): Promise<ResumeChoice[]> {
  const records = await getAll();
  return records
    .map((r) => ({ id: r.id, filename: r.filename, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

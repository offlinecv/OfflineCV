// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Resume library (#322) — the domain layer between the parse pipeline and the
 * local-first storage foundation (#321). Maps a parsed resume to a saved
 * `resumes` record and back, so a saved resume reloads straight into the results
 * view from its cached parse (no re-run of the cascade).
 *
 * This is the first in-repo consumer of `@/lib/storage`, and the place the
 * CascadeResult ↔ storage coupling lives — the foundation itself stays parser-
 * agnostic (it holds the parse as an opaque `parse` payload). The cached parse
 * round-trips via IndexedDB structured clone (which preserves the `sections`
 * Map), so loading is lossless; only the JSON export path (backup.ts) is lossy,
 * which is fine — export is a backup, not the reload path.
 */

import {
  saveResume,
  getResume,
  getAllResumes,
  deleteResume,
} from "./storage/index.ts";
import type { CascadeResult } from "./heuristics/types.ts";
import type { AnonymousAtsScore } from "./score/score.ts";

type SourceKind = "pdf" | "docx";

const MIME: Record<SourceKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** What we stash in the record's opaque `parse` slot: enough to restore the
 *  results view without re-parsing. Internal to this module — callers go through
 *  the save/load functions, not the raw snapshot. */
interface SavedResumeSnapshot {
  result: CascadeResult;
  score: AnonymousAtsScore;
  sourceKind: SourceKind;
}

/** A row in the library list — the light metadata the picker renders. */
export interface ResumeLibraryEntry {
  id: string;
  filename: string;
  /** Epoch ms of the last save (record `updatedAt`). */
  savedAt: number;
  /** Overall ATS score captured at save time. */
  scoreOverall: number;
  sourceKind: SourceKind;
}

/** Everything App needs to hydrate the "done" state from a saved resume. */
export interface LoadedResume {
  id: string;
  filename: string;
  fileSize: number;
  /** Source bytes for the PDF preview; absent for DOCX (no preview, as live). */
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  result: CascadeResult;
  score: AnonymousAtsScore;
}

function readSnapshot(parse: unknown): SavedResumeSnapshot | null {
  const snap = parse as Partial<SavedResumeSnapshot> | undefined;
  if (snap?.result == null || snap.score == null) return null;
  return {
    result: snap.result,
    score: snap.score,
    sourceKind: snap.sourceKind ?? "pdf",
  };
}

/** Save (or overwrite, when `id` is given) a resume. Bytes are stored as a Blob
 *  at rest; for DOCX (no source bytes kept in the done state) the blob is empty
 *  and reload restores from the cached parse alone. Returns the record id. */
export async function saveResumeToLibrary(input: {
  id?: string;
  filename: string;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  result: CascadeResult;
  score: AnonymousAtsScore;
}): Promise<string> {
  const blob = new Blob(input.bytes ? [input.bytes] : [], {
    type: MIME[input.sourceKind],
  });
  const snapshot: SavedResumeSnapshot = {
    result: input.result,
    score: input.score,
    sourceKind: input.sourceKind,
  };
  const record = await saveResume({
    id: input.id,
    filename: input.filename,
    blob,
    parse: snapshot,
  });
  return record.id;
}

/** List saved resumes, newest first. Records with a malformed snapshot are kept
 *  in the list (score 0) rather than hidden — the user can still delete them. */
export async function listLibrary(): Promise<ResumeLibraryEntry[]> {
  const records = await getAllResumes();
  return records
    .map((r) => {
      const snap = readSnapshot(r.parse);
      return {
        id: r.id,
        filename: r.filename,
        savedAt: r.updatedAt,
        scoreOverall: snap?.score.overall ?? 0,
        sourceKind: snap?.sourceKind ?? "pdf",
      };
    })
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Load a saved resume for hydration into the results view. Returns `undefined`
 *  when the record is gone or its cached parse is unreadable. */
export async function loadResumeFromLibrary(
  id: string,
): Promise<LoadedResume | undefined> {
  const record = await getResume(id);
  if (record === undefined) return undefined;
  const snap = readSnapshot(record.parse);
  if (snap === null) return undefined;
  const bytes =
    record.blob.size > 0 ? await record.blob.arrayBuffer() : undefined;
  return {
    id: record.id,
    filename: record.filename,
    fileSize: record.blob.size,
    bytes,
    sourceKind: snap.sourceKind,
    result: snap.result,
    score: snap.score,
  };
}

/** Rename a saved resume, preserving its bytes and cached parse. */
export async function renameLibraryResume(
  id: string,
  filename: string,
): Promise<void> {
  const record = await getResume(id);
  if (record === undefined) return;
  await saveResume({ id, filename, blob: record.blob, parse: record.parse });
}

/** Delete a saved resume. */
export function removeLibraryResume(id: string): Promise<void> {
  return deleteResume(id);
}

/** Approximate bytes used by this origin's storage (for the "space used" note),
 *  or null when the API is unavailable. */
export async function estimateStorageUsage(): Promise<number | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return null;
  }
  try {
    const { usage } = await navigator.storage.estimate();
    return usage ?? null;
  } catch {
    return null;
  }
}

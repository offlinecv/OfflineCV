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
import { runCascade } from "./heuristics/index.ts";
import { CANONICAL_SHAPE_VERSION } from "./heuristics/canonical.ts";
import { projectScoreSections } from "./heuristics/projections.ts";
import type { CascadeResult } from "./heuristics/types.ts";
import {
  computeAnonymousAtsScore,
  ATS_SCORE_ALGO_VERSION,
  type AnonymousAtsScore,
} from "./score/score.ts";

type SourceKind = "pdf" | "docx";

const MIME: Record<SourceKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Cache-key for the persisted parse+score record (#321 / #445). It composes the
 * score-algorithm version with the canonical parser-shape version, so a bump to
 * EITHER auto-invalidates a stored snapshot on read. A mismatch never silently
 * deserializes a stale record (e.g. a pre-cutover `CascadeResult` façade with no
 * `canonical` member) into the current shape — it re-parses from the stored PDF
 * blob instead. See {@link loadResumeFromLibrary}.
 */
const CACHE_SHAPE_VERSION = `${ATS_SCORE_ALGO_VERSION}:${CANONICAL_SHAPE_VERSION}`;

/** What we stash in the record's opaque `parse` slot: enough to restore the
 *  results view without re-parsing. Internal to this module — callers go through
 *  the save/load functions, not the raw snapshot. */
interface SavedResumeSnapshot {
  result: CascadeResult;
  score: AnonymousAtsScore;
  sourceKind: SourceKind;
  /** Shape version the record was written at ({@link CACHE_SHAPE_VERSION}).
   *  Absent on pre-#445 records — those read as `undefined`, which never matches
   *  the current version, so they re-parse rather than deserialize. */
  shapeVersion?: string;
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
    shapeVersion: snap.shapeVersion,
  };
}

/** Re-grade a (re-parsed) canonical result — mirrors the parse-time score
 *  computation in `useResumeAnalysis` exactly so a re-parsed record scores
 *  identically to a fresh upload. */
function scoreForResult(result: CascadeResult): AnonymousAtsScore {
  return computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    sections: projectScoreSections(result.canonical),
  });
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
    shapeVersion: CACHE_SHAPE_VERSION,
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

  // Stale-shape guard (#445 / #321). A record written at a different parser-shape
  // or score-algo version must NOT be deserialized as the current canonical
  // shape (a pre-cutover record has a `parsed`/`sections` façade and no
  // `canonical` member — reading it as canonical would crash downstream). Re-parse
  // from the stored PDF blob instead. If there is no blob to re-parse from (e.g. a
  // DOCX record, whose source bytes are not kept at rest), the record can't be
  // safely restored — drop it rather than hand back a stale shape.
  if (snap.shapeVersion !== CACHE_SHAPE_VERSION) {
    if (bytes === undefined) return undefined;
    const result = await runCascade(bytes);
    const score = scoreForResult(result);
    return {
      id: record.id,
      filename: record.filename,
      fileSize: record.blob.size,
      bytes,
      sourceKind: snap.sourceKind,
      result,
      score,
    };
  }

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

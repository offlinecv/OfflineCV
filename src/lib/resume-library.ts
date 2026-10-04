// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
import type { CascadeResult } from "./heuristics/types.ts";
import {
  ATS_SCORE_ALGO_VERSION,
  type AnonymousAtsScore,
} from "./score/score.ts";
import { scoreParsedResume } from "./score/score-cascade.ts";
import type { UnresolvedOverride } from "./edit/apply-overrides.ts";
import { foldEdit } from "./edit/edit-pipeline.ts";
import type { EditSnapshot } from "../hooks/useEditableParse.ts";

type SourceKind = "pdf" | "docx" | "markdown";

const MIME: Record<SourceKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown",
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
  /** The EDITED (flattened) result — kept even once {@link baseResult} and
   *  {@link edit} are also stored, for two reasons. `listLibrary` reads
   *  `score.overall` (below) without replaying anything, and this is the only
   *  thing that guarantees a reloaded résumé looks byte-identical to what the
   *  user saved even if `applyOverrides` later changes behaviour — the two are
   *  not one because `applyOverrides` evolving between the save and the load is
   *  exactly the drift #769 is scoped to handle, not this issue. */
  result: CascadeResult;
  score: AnonymousAtsScore;
  sourceKind: SourceKind;
  /** Shape version the record was written at ({@link CACHE_SHAPE_VERSION}).
   *  Absent on pre-#445 records — those read as `undefined`, which never matches
   *  the current version, so they re-parse rather than deserialize. */
  shapeVersion?: string;
  /**
   * The PRISTINE parse `edit` is a delta over (#768). Present only alongside
   * {@link edit} — a lone one is meaningless (there is nothing to replay it
   * onto, or nothing to derive from) so {@link readSnapshot} drops it unless
   * both are there. Absent on any record saved before this change, and on one
   * saved while `recovery.isLlmRecovered` was true (that `result` is not
   * `base` + `edit` — see `App.tsx`'s `useAutosaveResume` call).
   */
  baseResult?: CascadeResult;
  /** The delta that turns {@link baseResult} into {@link result} — see
   *  {@link baseResult} for when this is present. */
  edit?: EditSnapshot;
}

/** A row in the library list — the light metadata the picker renders. */
export interface ResumeLibraryEntry {
  id: string;
  filename: string;
  /** Epoch ms of the last save (record `updatedAt`). */
  savedAt: number;
  /** Overall ATS score captured at save time. `0` when `hasCachedParse` is
   *  false — a placeholder, not a genuine zero score; see {@link hasCachedParse}. */
  scoreOverall: number;
  sourceKind: SourceKind;
  /** Whether this record has a snapshot `readSnapshot` can use (#757). False
   *  for a record an outside producer wrote through the backup-import door
   *  with no cached parse — legal, and still loadable: `loadResumeFromLibrary`
   *  rebuilds it by re-parsing the stored blob (#758). It is NOT a broken
   *  record, and the UI must not read it as one; it just hasn't been parsed by
   *  this build yet. `scoreOverall` is meaningless when this is false, which is
   *  the whole reason it exists — before it, a record with no snapshot and a
   *  résumé that genuinely scored 0 rendered identically. */
  hasCachedParse: boolean;
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
  /** The pristine parse `edit` is a delta over (#768) — present only when the
   *  stored snapshot carries both this and `edit`; see {@link readSnapshot}. */
  baseResult?: CascadeResult;
  /** The delta that turns `baseResult` into `result` (#768). */
  edit?: EditSnapshot;
  /**
   * Every override `edit` names that no longer resolves against the CURRENT
   * `baseResult` (#769) — a stale-delta report, not a UI signal (#770 renders
   * it). Computed at load time with the same recipe `computeSavableResult`
   * (`edit-pipeline.ts`) uses to reproduce the stored `result`, so the two
   * folds cannot drift into disagreeing about what "resolves" means.
   *
   * Present only alongside {@link baseResult} + {@link edit} (a delta-carrying
   * record) — absent for a flat record and for the re-parse recovery branch,
   * neither of which replays a delta. Empty, not absent, when the base has not
   * moved since the delta was written.
   */
  unresolved?: readonly UnresolvedOverride[];
}

/** Both-or-neither (#768): a lone `baseResult` has no delta to apply, and a
 *  lone `edit` has nothing to apply it to — either is a malformed pair this
 *  module never produces itself, so both {@link readSnapshot} and
 *  {@link saveResumeToLibrary} degrade to a flat record rather than reading or
 *  writing a half-formed delta. One definition so the two guards cannot drift. */
function hasDelta(
  baseResult: CascadeResult | undefined,
  edit: EditSnapshot | undefined,
): boolean {
  return baseResult !== undefined && edit !== undefined;
}

/** Whether a STORED delta pair can actually be restored — checked on read only,
 *  because a write from this module always passes it. `hydrateFromLibrary`
 *  hands `baseResult` straight to `scoreParsedResume` and `edit` to `replay`,
 *  so a pair that fails here would throw mid-restore instead of loading (review,
 *  #1087). Two ways a record gets here: a hand-edited backup, and — the common
 *  one — ANY backup import, because a JSON round-trip turns
 *  `sections.byName`'s `Map` into `{}` (`record-contract.ts` spells out that
 *  rewrite). The `Map` check is what tells a structured-clone-intact parse from
 *  one that crossed JSON; the rest is the minimum `scoreParsedResume`, `replay`,
 *  and `applyOverrides` dereference — `rawText` included, since a bullet-text
 *  edit rewrites it via `withMatchedRawTextLine`'s `.split`, which throws on a
 *  non-string rather than degrading; `accomplishmentSections` as an array,
 *  since `scoreParsedResume` walks it with a bare `for...of`; and
 *  `bulletOverrides` as undefined-or-object, since `applyOverrides` defaults it
 *  with `= {}`, which only fires on `undefined` and lets a stored `null` reach
 *  its `Object.entries` call. A pair that fails degrades to the flat `result`
 *  and `score`, the same record a pre-#768 build would have loaded. */
function isRestorableDelta(baseResult: unknown, edit: unknown): boolean {
  const base = baseResult as Partial<CascadeResult> | null | undefined;
  const snapshot = edit as Partial<EditSnapshot> | null | undefined;
  return (
    base?.canonical?.sections?.byName instanceof Map &&
    Array.isArray(base.canonical.sections.accomplishmentSections) &&
    typeof base.canonical.fields === "object" &&
    base.canonical.fields !== null &&
    Array.isArray(base.triggers) &&
    typeof base.rawText === "string" &&
    typeof snapshot === "object" &&
    snapshot !== null &&
    Array.isArray(snapshot.removedBullets) &&
    (snapshot.bulletOverrides === undefined ||
      (typeof snapshot.bulletOverrides === "object" &&
        snapshot.bulletOverrides !== null))
  );
}

/**
 * Fold `edit` over `base` via {@link foldEdit} — the SAME expression
 * {@link computeSavableResult} (`edit-pipeline.ts`) folds through to reproduce
 * a stored `result` — and report what did not resolve (#769). Calls `foldEdit`
 * rather than `computeSavableResult` itself because that helper flattens
 * straight to a `CascadeResult` via `flattenEditedResult`, which discards
 * `unresolved`; this needs the intermediate `ApplyOverridesResult` for that one
 * field. Sharing `foldEdit` (instead of a hand-copy of its expression) is what
 * keeps this and `computeSavableResult` from silently diverging.
 *
 * Never throws: a `baseResult` that cannot be scored (a malformed record, a
 * hand-built test double predating this field) reports no unresolved
 * overrides rather than failing the whole load — the same "never throws
 * mid-restore" contract {@link isRestorableDelta} already keeps for the pair
 * as a whole.
 */
function foldUnresolvedOverrides(
  base: CascadeResult,
  edit: EditSnapshot,
): readonly UnresolvedOverride[] {
  try {
    const scoreBullets = scoreParsedResume(base).bullets ?? [];
    return foldEdit(base, scoreBullets, edit).unresolved;
  } catch {
    return [];
  }
}

function readSnapshot(parse: unknown): SavedResumeSnapshot | null {
  const snap = parse as Partial<SavedResumeSnapshot> | undefined;
  if (snap?.result == null || snap.score == null) return null;
  const delta =
    hasDelta(snap.baseResult, snap.edit) &&
    isRestorableDelta(snap.baseResult, snap.edit);
  return {
    result: snap.result,
    score: snap.score,
    sourceKind: snap.sourceKind ?? "pdf",
    shapeVersion: snap.shapeVersion,
    baseResult: delta ? snap.baseResult : undefined,
    edit: delta ? snap.edit : undefined,
  };
}

/** What a save is asked to persist. `bytesUnchanged` is the caller's assertion
 *  about the SOURCE FILE, not about the parse — see {@link blobForSave}. */
export interface SaveResumeToLibraryInput {
  id?: string;
  filename: string;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  result: CascadeResult;
  score: AnonymousAtsScore;
  /** The pristine parse `edit` is a delta over (#768). Optional, and both-or-
   *  neither with {@link edit} — see {@link SavedResumeSnapshot.baseResult}. */
  baseResult?: CascadeResult;
  /** The delta that turns `baseResult` into `result` (#768). */
  edit?: EditSnapshot;
  /**
   * The caller asserts that the record at `id` already holds exactly the bytes
   * this save would otherwise write, so the stored Blob may be carried forward
   * untouched. Ignored without an `id` (a new record has nothing to carry).
   *
   * Opt-in rather than inferred, and that is the point. The assertion is true
   * for the autosave path (#824) BY CONSTRUCTION — the record id is keyed to
   * the parse identity `useAnalyzedResume` mints, and a new source file always
   * mints a new one, so an id and the bytes under it can never be re-paired —
   * but it is not true of "an update" in general, and a future caller that
   * legitimately re-writes a record's bytes (a re-upload against an existing
   * record, an import) must not silently inherit a fast path that would drop
   * its write. Defaults to rebuilding the Blob, which is always correct.
   */
  bytesUnchanged?: boolean;
}

/**
 * The Blob to store for this save.
 *
 * Rebuilding it from `input.bytes` copies the whole source file on every call,
 * which was fine when a save was a button click and is not when it is a
 * debounced write behind every edit (#824) — a multi-MB PDF re-copied and
 * re-written per debounce window. When the caller can assert the bytes are the
 * ones already at rest, the stored Blob is carried forward instead and only the
 * snapshot advances — the same move `loadResumeFromLibrary`'s re-stamp makes.
 *
 * Falls back to rebuilding when the record has gone (deleted in another tab
 * between the assertion and this read), so a stale id degrades to a fresh
 * write rather than to a record with no bytes.
 */
async function blobForSave(input: SaveResumeToLibraryInput): Promise<Blob> {
  if (input.id !== undefined && input.bytesUnchanged === true) {
    const existing = await getResume(input.id);
    if (existing !== undefined) return existing.blob;
  }
  return new Blob(input.bytes ? [input.bytes] : [], {
    type: MIME[input.sourceKind],
  });
}

/** Save (or overwrite, when `id` is given) a resume. Bytes are stored as a Blob
 *  at rest; for DOCX (no source bytes kept in the done state) the blob is empty
 *  and reload restores from the cached parse alone. Returns the record id. */
export async function saveResumeToLibrary(
  input: SaveResumeToLibraryInput,
): Promise<string> {
  const blob = await blobForSave(input);
  const delta = hasDelta(input.baseResult, input.edit);
  const snapshot: SavedResumeSnapshot = {
    result: input.result,
    score: input.score,
    sourceKind: input.sourceKind,
    shapeVersion: CACHE_SHAPE_VERSION,
    baseResult: delta ? input.baseResult : undefined,
    edit: delta ? input.edit : undefined,
  };
  const record = await saveResume({
    id: input.id,
    filename: input.filename,
    blob,
    parse: snapshot,
  });
  return record.id;
}

/** List saved resumes, newest first. Records with no readable snapshot are kept
 *  in the list rather than hidden — the user can still delete them — but are
 *  reported with `hasCachedParse: false` (#757) rather than a `scoreOverall`
 *  that reads as a genuine zero. */
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
        hasCachedParse: snap !== null,
      };
    })
    .sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
}

/**
 * The id of the most recently saved entry, or `undefined` for an empty list.
 *
 * Two consumers now ask the same question — `/jobs/`'s tracker fallback
 * (`useFallbackResume`, #724) and `/`'s cold-mount auto-restore
 * (`useAutoRestoreResume`, #812) — so the answer has one definition. Reduces to
 * the largest `savedAt` rather than taking `listLibrary`'s first element: that
 * function does sort newest-first today, and this deliberately does not lean on
 * that staying true, since a caller holding a list from anywhere else would get
 * a silently wrong résumé rather than a type error.
 */
export function newestLibraryEntryId(
  entries: readonly ResumeLibraryEntry[],
): string | undefined {
  if (entries.length === 0) return undefined;
  return entries.reduce((newest, entry) =>
    entry.savedAt > newest.savedAt ? entry : newest,
  ).id;
}

/** The kind a record's stored bytes actually are, for a record whose snapshot
 *  cannot say. Reverse of {@link MIME}; unknown/blank types read as `pdf`,
 *  which is what every producer that writes bytes writes today. */
function sourceKindOfBlob(blob: Blob): SourceKind {
  for (const [kind, mime] of Object.entries(MIME) as [SourceKind, string][]) {
    if (blob.type === mime) return kind;
  }
  return "pdf";
}

/** Load a saved resume for hydration into the results view. Returns `undefined`
 *  when the record is gone, or when its parse can neither be read nor rebuilt
 *  from the stored bytes. */
export async function loadResumeFromLibrary(
  id: string,
): Promise<LoadedResume | undefined> {
  const record = await getResume(id);
  if (record === undefined) return undefined;
  const snap = readSnapshot(record.parse);
  const bytes =
    record.blob.size > 0 ? await record.blob.arrayBuffer() : undefined;

  // Rebuild from the stored bytes whenever the cached parse cannot be used as
  // it stands. Two ways that happens, and they take the same recovery:
  //
  //  - **No cached parse at all** (`snap === null`). Reachable since #693 put a
  //    public write door on this store: a producer outside this build imports a
  //    `ResumeRecord` carrying the PDF and no `parse`, because it cannot run the
  //    cascade. Such a record lists fine (`listLibrary` keeps it at score 0) and
  //    used to load as `undefined`, which made `/jobs/`'s #724 fallback rate
  //    NOTHING — no stars on any row, no console line, and `hasResume === false`
  //    so the tracker showed the "open this from your resume" prompt against a
  //    résumé that was sitting right there. The bytes are present; refusing them
  //    was the bug.
  //  - **Stale shape** (#445 / #321). A record written at a different
  //    parser-shape or score-algo version must NOT be deserialized as the
  //    current canonical shape (a pre-cutover record has a `parsed`/`sections`
  //    façade and no `canonical` member — reading it as canonical would crash
  //    downstream).
  //
  // Either way: no blob to rebuild from (a DOCX record, whose source bytes are
  // not kept at rest) means the record can't be safely restored — drop it rather
  // than hand back a stale or absent shape.
  if (snap === null || snap.shapeVersion !== CACHE_SHAPE_VERSION) {
    if (bytes === undefined) return undefined;
    const sourceKind = snap?.sourceKind ?? sourceKindOfBlob(record.blob);
    // `runCascade` reads PDF bytes. A non-PDF record with no usable snapshot has
    // nothing this module can rebuild from, so it degrades to "not loadable"
    // rather than throwing inside the cascade.
    if (sourceKind !== "pdf") return undefined;
    const result = await runCascade(bytes);
    // The SHARED base-grade recipe (#652), not a local copy of it: a re-parsed
    // record has to score identically to a fresh upload, and that only holds
    // while both go through the same constructor.
    const score = scoreParsedResume(result);
    // Re-stamp the record at the current shape version so this migration is a
    // one-time cost (#452 review). Without re-saving, every subsequent load of a
    // stale record re-parses from the Blob again. Preserve the stored blob and id;
    // only the snapshot advances. Best-effort — a failed re-save just means the
    // next load re-parses, so hydration never blocks on it.
    const migrated: SavedResumeSnapshot = {
      result,
      score,
      sourceKind,
      shapeVersion: CACHE_SHAPE_VERSION,
    };
    try {
      await saveResume({
        id: record.id,
        filename: record.filename,
        blob: record.blob,
        parse: migrated,
      });
    } catch {
      // non-fatal: leave the record stale; it re-parses on the next load.
    }
    return {
      id: record.id,
      filename: record.filename,
      fileSize: record.blob.size,
      bytes,
      sourceKind,
      result,
      score,
    };
  }

  let unresolved: readonly UnresolvedOverride[] | undefined;
  if (snap.baseResult !== undefined && snap.edit !== undefined) {
    unresolved = foldUnresolvedOverrides(snap.baseResult, snap.edit);
  }

  return {
    id: record.id,
    filename: record.filename,
    fileSize: record.blob.size,
    bytes,
    sourceKind: snap.sourceKind,
    result: snap.result,
    score: snap.score,
    baseResult: snap.baseResult,
    edit: snap.edit,
    // Spread, not assign: a flat record gets no own `unresolved` key at all.
    ...(unresolved !== undefined && { unresolved }),
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

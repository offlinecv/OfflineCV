// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useResumeAnalysis — owns the ParseState machine, file-handling logic,
 * and parse→score→telemetry pipeline.
 *
 * Extracted from App.tsx (issue #83) so App becomes layout-only.
 * formatBytes is re-exported here so callers that need it (e.g. the DropZone
 * status string) don't need a separate import.
 */

import { useState, useCallback, useRef } from "react";
import { runCascade, runCascadeFromMarkdown } from "../lib/heuristics";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { parseDocx } from "../lib/ingest/docx.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import {
  trackBlankResumeStarted,
  trackCascadeEvent,
  trackFileAccepted,
  trackParseCompleted,
  trackParseFailed,
} from "../lib/analytics.ts";
import { formatBytes } from "../lib/format-bytes.ts";
import type {
  ContactOverrides,
  ExperienceFieldOverrides,
  EducationFieldOverrides,
  BulletOverrides,
  SkillsOverride,
  AddedEntry,
  AddedBullets,
} from "./useEditableParse.ts";

// ── Types ────────────────────────────────────────────────────────────────────

type SourceKind = "pdf" | "docx";

/**
 * A serializable snapshot of the from-scratch draft's edit-override state
 * (#313) — the SAME shape `useEditableParse` exposes, persisted verbatim so
 * a restore can replay it through the hook's own public setters (in
 * `useAnalyzedResume.ts`) rather than reaching into its internals.
 * `removedBullets` is serialized as an array — a `Set` isn't JSON-safe.
 */
export interface BlankDraftSnapshot {
  contactOverrides: ContactOverrides;
  experienceOverrides: Record<number, ExperienceFieldOverrides>;
  bulletOverrides: BulletOverrides;
  removedBullets: number[];
  educationOverrides: Record<number, EducationFieldOverrides>;
  skillsOverride: SkillsOverride;
  addedEntries: AddedEntry[];
  addedBullets: AddedBullets;
}

export type ParseState =
  | { phase: "idle" }
  | { phase: "parsing"; fileName: string; fileSize: number }
  | {
      phase: "done";
      fileName: string;
      fileSize: number;
      /** Raw bytes — only present for PDF (used by PdfPreview). Absent for DOCX. */
      bytes?: ArrayBuffer;
      sourceKind: SourceKind;
      result: CascadeResult;
      score: AnonymousAtsScore;
    }
  | {
      phase: "authoring";
      /** Non-null while a saved draft was detected on entry and hasn't been
       *  resolved yet — the caller (App) shows the resume-vs-start-over
       *  prompt instead of mounting the editor. Null once resolved: a fresh
       *  start (no draft found, or the user picked "start over"), or a
       *  resumed draft whose overrides have already been replayed into
       *  `useEditableParse`. */
      pendingDraft: BlankDraftSnapshot | null;
      /** Bumped only on a FRESH edit-state (no draft found, or explicit
       *  start-over) — never on a resumed draft. `useAnalyzedResume`'s
       *  "clear edits" effect keys on this so resuming a draft doesn't
       *  immediately wipe the overrides it just replayed. */
      generation: number;
    }
  | { phase: "error"; message: string };

export interface ResumeAnalysis {
  state: ParseState;
  handleFile: (file: File) => Promise<void>;
  reset: () => void;
  /** Re-exported so App.tsx doesn't need a second import. */
  formatBytes: (n: number) => string;
  /** Enter the from-scratch authoring flow (#313). Checks for a saved draft
   *  first — if one exists, the resulting state carries it as `pendingDraft`
   *  rather than mounting the editor immediately. */
  startBlank: () => void;
  /** Resolve a shown draft prompt for the "resume" choice — the caller has
   *  already replayed the draft's overrides into `useEditableParse`. Clears
   *  `pendingDraft` (without bumping `generation`) so the editor mounts on
   *  top of the just-replayed state. Use `startOverBlank` for "start over". */
  resolveDraftPrompt: () => void;
  /** Start a genuinely fresh blank session (used by "start over"): clears
   *  `pendingDraft` AND bumps `generation` so the reset-edits effect fires. */
  startOverBlank: () => void;
}

// ── Draft persistence (#313) ─────────────────────────────────────────────────

/** localStorage key for the in-progress from-scratch draft, following the
 *  `rl_*` functional-key convention (README's Telemetry section). Exported so
 *  `useDownloadPdf` can clear it on a successful blank-authored export
 *  without sharing any React state with this hook. */
export const BLANK_DRAFT_STORAGE_KEY = "rl_blank_draft";

function isBlankDraftSnapshot(value: unknown): value is BlankDraftSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.contactOverrides === "object" &&
    v.contactOverrides !== null &&
    typeof v.experienceOverrides === "object" &&
    v.experienceOverrides !== null &&
    typeof v.bulletOverrides === "object" &&
    v.bulletOverrides !== null &&
    Array.isArray(v.removedBullets) &&
    typeof v.educationOverrides === "object" &&
    v.educationOverrides !== null &&
    typeof v.skillsOverride === "object" &&
    v.skillsOverride !== null &&
    Array.isArray(v.addedEntries) &&
    typeof v.addedBullets === "object" &&
    v.addedBullets !== null
  );
}

/** Read the saved blank-authoring draft, or null if absent/unparseable. */
function readBlankDraft(): BlankDraftSnapshot | null {
  try {
    const raw = localStorage.getItem(BLANK_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBlankDraftSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the current blank-authoring override state. Best-effort — a quota
 *  or serialization failure just means the draft doesn't survive reload. */
export function writeBlankDraft(snapshot: BlankDraftSnapshot): void {
  try {
    localStorage.setItem(BLANK_DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // best-effort; ignore quota/serialization errors
  }
}

/** Clear the saved draft — explicit start-over, successful export, or
 *  leaving the authoring flow entirely (#313). Idempotent; safe to call
 *  unconditionally. */
export function clearBlankDraft(): void {
  try {
    localStorage.removeItem(BLANK_DRAFT_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useResumeAnalysis(): ResumeAnalysis {
  const [state, setState] = useState<ParseState>({ phase: "idle" });

  const handleFile = useCallback(async (file: File) => {
    trackFileAccepted(file.size);
    setState({ phase: "parsing", fileName: file.name, fileSize: file.size });

    const isDocxFile =
      file.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.name.toLowerCase().endsWith(".docx");

    try {
      const bytes = await file.arrayBuffer();
      let result: CascadeResult;
      let pdfBytes: ArrayBuffer | undefined;

      if (isDocxFile) {
        // DOCX path — extract markdown via mammoth+turndown, then cascade on it.
        const { rawText, markdown } = await parseDocx(bytes);
        result = await runCascadeFromMarkdown(rawText, markdown, {
          userType: "anon",
          onEvent: trackCascadeEvent,
        });
        // No PDF bytes to store — PdfPreview won't be shown.
        pdfBytes = undefined;
      } else {
        // PDF path — pdfjs mutates the buffer it parses; hand it a copy so we
        // can re-render the source PDF in the side-by-side preview afterward.
        result = await runCascade(bytes.slice(0), {
          userType: "anon",
          onEvent: trackCascadeEvent,
        });
        pdfBytes = bytes;
      }

      const score = computeAnonymousAtsScore({
        parsed: result.parsed,
        fieldConfidence: result.fieldConfidence,
        triggers: result.triggers,
        rawText: result.rawText,
        sections: result.sections,
      });

      trackParseCompleted({
        pages: result.diagnostics.pages,
        elapsedMs: result.diagnostics.elapsedMs,
        scoreOverall: score.overall,
        scoreSpecificity: score.specificity.score,
        scoreStructure: score.structure.score,
        scoreCompleteness: score.completeness.score,
        triggers: result.triggers,
        algoVersion: score.algoVersion ?? "",
        layoutMultiplier: score.layout.multiplier,
      });

      setState({
        phase: "done",
        fileName: file.name,
        fileSize: file.size,
        bytes: pdfBytes,
        sourceKind: isDocxFile ? "docx" : "pdf",
        result,
        score,
      });
    } catch (err) {
      trackParseFailed({
        errorName: err instanceof Error ? err.name : "Unknown",
        fileSize: file.size,
      });
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const reset = useCallback(() => {
    // A "back"/reset control always discards any in-progress from-scratch
    // draft too (#313 AC) — idempotent no-op when there wasn't one.
    clearBlankDraft();
    setState({ phase: "idle" });
  }, []);

  // Monotonic source of "fresh authoring generation" ids. A ref (not state)
  // because minting one must not itself trigger a render — only the
  // `generation` value stored on `ParseState` does that. Never reset, even
  // across multiple blank sessions in one page lifetime.
  const freshGenerationRef = useRef(0);

  const startBlank = useCallback(() => {
    trackBlankResumeStarted();
    const pendingDraft = readBlankDraft();
    setState({
      phase: "authoring",
      pendingDraft,
      // No draft found: this is already a fresh session, so mint a fresh
      // generation now. A draft WAS found: the generation is irrelevant
      // until the prompt resolves (see `resolveDraftPrompt`/`startOverBlank`),
      // since the reset-edits effect only reads it once `pendingDraft` is
      // null — use a placeholder that's never read.
      generation: pendingDraft === null ? freshGenerationRef.current++ : -1,
    });
  }, []);

  const resolveDraftPrompt = useCallback(() => {
    // Used for "resume": the caller has already replayed the draft's
    // overrides into `useEditableParse` — clear `pendingDraft` WITHOUT
    // bumping `generation`, so the reset-edits effect (keyed on `generation`)
    // does not fire and wipe the just-replayed state.
    setState((prev) =>
      prev.phase === "authoring"
        ? { phase: "authoring", pendingDraft: null, generation: prev.generation }
        : prev,
    );
  }, []);

  const startOverBlank = useCallback(() => {
    // Used for "start over": discard the saved draft and mint a genuinely
    // fresh generation so the reset-edits effect fires (a no-op safety net
    // here, since nothing was ever replayed into `useEditableParse`).
    clearBlankDraft();
    setState((prev) =>
      prev.phase === "authoring"
        ? {
            phase: "authoring",
            pendingDraft: null,
            generation: freshGenerationRef.current++,
          }
        : prev,
    );
  }, []);

  return {
    state,
    handleFile,
    reset,
    formatBytes,
    startBlank,
    resolveDraftPrompt,
    startOverBlank,
  };
}

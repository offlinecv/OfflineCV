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

import { useState, useCallback } from "react";
import { runCascade, runCascadeFromMarkdown } from "../lib/heuristics";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { parseDocx } from "../lib/ingest/docx.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import {
  trackCascadeEvent,
  trackFileAccepted,
  trackParseCompleted,
  trackParseFailed,
} from "../lib/analytics.ts";
import { formatBytes } from "../lib/format-bytes.ts";

// ── Types ────────────────────────────────────────────────────────────────────

type SourceKind = "pdf" | "docx";

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
  | { phase: "error"; message: string };

export interface ResumeAnalysis {
  state: ParseState;
  handleFile: (file: File) => Promise<void>;
  reset: () => void;
  /** Re-exported so App.tsx doesn't need a second import. */
  formatBytes: (n: number) => string;
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

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, handleFile, reset, formatBytes };
}

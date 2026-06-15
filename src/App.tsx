// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useCallback, useMemo, useState } from "react";
import { Chip } from "./components/ui/Chip.tsx";
import { DropZone } from "./components/DropZone";
import { Result } from "./components/Result";
import { JdMatch } from "./components/features/JdMatch.tsx";
import { JdInput } from "./components/features/JdInput.tsx";
import { ErrorState } from "./components/shared/ErrorState.tsx";
import { runCascade, runCascadeFromMarkdown } from "./lib/heuristics";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import { parseDocx } from "./lib/ingest/docx.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "./lib/score/score.ts";
import {
  trackCascadeEvent,
  trackFileAccepted,
  trackParseCompleted,
  trackParseFailed,
} from "./lib/analytics.ts";
import { extractJdTerms, computeCoverage } from "./lib/jd-match";

type SourceKind = "pdf" | "docx";

type ParseState =
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [state, setState] = useState<ParseState>({ phase: "idle" });
  const [jdText, setJdText] = useState("");

  const jdMatch = useMemo(() => {
    const trimmed = jdText.trim();
    if (trimmed.length === 0) return null;
    if (state.phase !== "done") return null;
    const extracted = extractJdTerms(trimmed);
    if (extracted.all.length === 0) return null;
    const coverage = computeCoverage(state.result.parsed, extracted.all);
    return { extracted, coverage };
  }, [jdText, state]);

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

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-grid h-8 w-8 place-items-center rounded-md bg-brand-amber text-base font-bold text-content-inverse">
              R
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">resumelint</h1>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
              alpha
            </span>
          </div>
          <p className="hidden text-xs text-content-muted sm:block">
            PDF parser stress test for resumes
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip icon="⚡">~30 seconds</Chip>
          <Chip icon="🔒">Runs in your browser</Chip>
          <Chip icon="✓">No signup required</Chip>
        </div>
      </header>

      {state.phase !== "done" && (
        <section className="flex flex-col gap-3">
          <p className="max-w-prose text-sm text-neutral-700 dark:text-neutral-300">
            Drop a resume PDF below to see what a generic text extractor reads
            back. This is a diagnostic — not a verdict from any specific
            applicant tracking system.
          </p>
          <DropZone
            onFile={handleFile}
            disabled={state.phase === "parsing"}
            status={
              state.phase === "parsing"
                ? `Parsing ${state.fileName} (${formatBytes(state.fileSize)})…`
                : undefined
            }
          />
        </section>
      )}

      {state.phase === "error" && (
        <ErrorState>Couldn't parse that PDF: {state.message}</ErrorState>
      )}

      {state.phase === "done" && (
        <Result
          result={state.result}
          score={state.score}
          bytes={state.bytes}
          sourceKind={state.sourceKind}
          onReset={reset}
        />
      )}

      <JdInput
        value={jdText}
        onChange={setJdText}
        resumeParsed={state.phase === "done"}
      />

      {jdMatch && (
        <JdMatch
          coverage={jdMatch.coverage}
          terms={jdMatch.extracted.all}
          nounsDropped={jdMatch.extracted.nounsDropped}
        />
      )}

      <footer className="mt-auto flex flex-col gap-2 border-t border-neutral-200 pt-6 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        <p>Your PDF stays in this browser tab.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a
            href="https://github.com/resumelint-org/resumelint"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            GitHub
          </a>
          <a
            href="https://github.com/resumelint-org/resumelint/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            License
          </a>
          <a
            href="https://www.hbs.edu/managing-the-future-of-work/research/Pages/hidden-workers-untapped-talent.aspx"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            Further reading: HBS Hidden Workers
          </a>
        </div>
      </footer>
    </main>
  );
}

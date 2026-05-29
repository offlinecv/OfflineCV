// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useCallback, useState } from "react";
import { DropZone } from "./components/DropZone";
import { Result } from "./components/Result";
import { runCascade } from "./lib/heuristics";
import type { CascadeResult } from "./lib/heuristics/types.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "./lib/score/score.ts";
import {
  trackFileAccepted,
  trackParseCompleted,
  trackParseFailed,
} from "./lib/analytics.ts";

type ParseState =
  | { phase: "idle" }
  | { phase: "parsing"; fileName: string; fileSize: number }
  | {
      phase: "done";
      fileName: string;
      fileSize: number;
      bytes: ArrayBuffer;
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

  const handleFile = useCallback(async (file: File) => {
    trackFileAccepted(file.size);
    setState({ phase: "parsing", fileName: file.name, fileSize: file.size });
    try {
      const bytes = await file.arrayBuffer();
      // pdfjs mutates the buffer it parses; hand it a copy so we can re-render
      // the source PDF in the side-by-side preview afterward.
      const result = await runCascade(bytes.slice(0), {
        userType: "anon",
      });
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
        bytes,
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
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">resumelint</h1>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            alpha
          </span>
        </div>
        <p className="hidden text-xs text-neutral-500 sm:block">
          PDF parser stress test for resumes
        </p>
      </header>

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
              : state.phase === "done"
                ? `${state.fileName} (${formatBytes(state.fileSize)})`
                : undefined
          }
        />
      </section>

      {state.phase === "error" && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Couldn't parse that PDF: {state.message}
        </p>
      )}

      {state.phase === "done" && (
        <Result
          result={state.result}
          score={state.score}
          bytes={state.bytes}
          onReset={reset}
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

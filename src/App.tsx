// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { Chip, ErrorState, ErrorBoundary, Button } from "@design-system";
import { DropZone } from "./components/DropZone";
import { Result } from "./components/Result";
import { PageShell } from "./components/features/PageShell.tsx";
import { useAnalyzedResume } from "./hooks/useAnalyzedResume.ts";
import { writeJdFitHandoff } from "./lib/jd-fit-handoff.ts";

export default function App() {
  const { state, edit, edited, handleFile, reset, formatBytes } =
    useAnalyzedResume();

  // Cross-link to /jd-fit (#226). On click we stash the edited parse in
  // sessionStorage (one-shot handoff) so JD-fit rehydrates it without
  // re-parsing, then navigate to the base-aware /jd-fit URL — works under both
  // the custom-domain "/" base and the "/resumelint/" Pages-fallback base.
  const goToJdFit = () => {
    if (state.phase === "done" && edited) {
      writeJdFitHandoff({
        result: { ...state.result, parsed: edited.parsed },
        score: edited.score,
      });
    }
    window.location.href = `${import.meta.env.BASE_URL}jd-fit`;
  };

  return (
    <PageShell
      subtitle="PDF parser stress test for resumes"
      badge="alpha"
      chips={
        <>
          <Chip icon="⚡">A few seconds</Chip>
          <Chip icon="🔒">Runs in your browser</Chip>
          <Chip icon="✓">No signup required</Chip>
        </>
      }
    >
      {state.phase !== "done" && (
        <section className="flex flex-col gap-3">
          <p className="max-w-prose text-sm text-content-secondary">
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

      <ErrorBoundary onReset={reset}>
        {state.phase === "done" && edited && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
              <p className="text-sm text-content-secondary">
                Tailoring this resume to a specific role?
              </p>
              <Button variant="primary" size="sm" onClick={goToJdFit}>
                Check fit against a job →
              </Button>
            </div>
            <Result
              // `parsed` carries the edited experience descriptions so
              // `groupBulletsByExperience` (in ReconstructedResume) attributes
              // edited bullets to the SAME role they came from. Without this,
              // an edit displaces the bullet into the trailing "Other bullets"
              // group because the original description no longer substring-
              // matches the edited bullet text. `rawText` stays original on
              // purpose — EvidencePanel shows "what the PDF extracted", not
              // "what the user typed."
              result={{ ...state.result, parsed: edited.parsed }}
              score={edited.score}
              bytes={state.bytes}
              sourceKind={state.sourceKind}
              onReset={reset}
              edit={edit}
            />
          </>
        )}
      </ErrorBoundary>
    </PageShell>
  );
}

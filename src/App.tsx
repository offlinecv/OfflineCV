// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { Card, Chip, ErrorState, ErrorBoundary, Button } from "@design-system";
import { DropZone } from "./components/DropZone";
import { Result } from "./components/Result";
import { PageShell } from "./components/features/PageShell.tsx";
import { useAnalyzedResume } from "./hooks/useAnalyzedResume.ts";
import { writeJdFitHandoff } from "./lib/jd-fit-handoff.ts";
import { useFlag } from "./lib/flags.ts";

export default function App() {
  const { state, edit, edited, handleFile, reset, formatBytes } =
    useAnalyzedResume();

  // Cross-sell to the `/jd-fit/` surface is gated (default off) — `/jd-fit/` is
  // alpha and not ready to promote from the parser result. See lib/flags.ts.
  const jdFitEnabled = useFlag("jd-fit-banner");

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
    window.location.href = `${import.meta.env.BASE_URL}jd-fit/`;
  };

  return (
    <PageShell
      subtitle="A parser audit for your resume — not a judge"
      badge="alpha"
      chips={
        <>
          <Chip icon="⚡">A few seconds</Chip>
          <Chip icon="🔒">Your file never leaves your device</Chip>
          <Chip icon="✓">No account, no email</Chip>
          <Chip icon="🔁">Same PDF, same score</Chip>
        </>
      }
    >
      {state.phase !== "done" && (
        // Pre-drop landing column: narrower than the results view and centered
        // so whitespace frames the composition symmetrically instead of
        // pooling to the right of left-anchored text. Everything scannable
        // (headline, stat, promise, source) centers on the drop-zone axis;
        // multi-line prose (the agent block) stays left-aligned for reading.
        <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {(state.phase === "idle" || state.phase === "error") && (
            <Card className="flex flex-col gap-5 bg-surface-card-warm">
              <h2 className="text-balance text-center text-2xl font-semibold leading-snug tracking-tight text-content-primary sm:text-3xl">
                Recruiters and screeners don&apos;t read your PDF.{" "}
                <span className="font-normal text-content-secondary">
                  They read what a parser pulls out of it.
                </span>
              </h2>
              <p className="text-pretty text-center text-sm text-content-muted">
                AI is now part of most hiring pipelines — and{" "}
                <span className="font-medium text-content-secondary">
                  nearly half of job seekers
                </span>{" "}
                say they&apos;ve lost trust in a process they can&apos;t see into.
                <span
                  aria-hidden="true"
                  className="align-super text-xs text-brand-amber"
                >
                  1
                </span>
              </p>
              <p className="text-pretty text-center text-base font-medium text-content-primary sm:text-lg">
                resumelint shows you what a generic parser reads back from your
                resume — free, private, open-source.
              </p>
              <p className="text-center text-xs text-content-muted">
                Source:{" "}
                <a
                  href="https://www.greenhouse.com/newsroom/an-ai-trust-crisis-70-of-hiring-managers-trust-ai-to-make-faster-and-better-hiring-decisions-only-8-of-job-seekers-call-it-fair"
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  className="hover:underline"
                >
                  Greenhouse, 2025 AI in Hiring Report (4,100+ job seekers and hiring managers)
                </a>
              </p>
            </Card>
          )}

          <DropZone
            onFile={handleFile}
            disabled={state.phase === "parsing"}
            status={
              state.phase === "parsing"
                ? `Parsing ${state.fileName} (${formatBytes(state.fileSize)})…`
                : undefined
            }
          />

          {(state.phase === "idle" || state.phase === "error") && (
            // "Screened by an agent" framing (internal #21): the recruiter-side
            // proof point that the mirror positioning stands on. Quiet block
            // below the drop zone — context, never competing with the primary
            // action. Claims stay scoped per the fact-check rulings: privacy is
            // file-scoped, determinism is score-scoped. Per the public-copy
            // policy (internal #24) we never name other products here — the
            // trend is described generically, no links to specific tools.
            <div className="rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
              <p className="text-pretty text-sm text-content-secondary">
                <span className="font-medium text-content-primary">
                  Recruiters are starting to run AI agents over resumes.
                </span>{" "}
                Several recent open-source projects score candidates for
                recruiters. resumelint is the candidate-side mirror: it shows
                you what survives the parse — before you hit submit. The
                score isn&apos;t a verdict on you as a candidate — it measures
                how well a machine can read your resume.
              </p>
            </div>
          )}
        </section>
      )}

      {state.phase === "error" && (
        <ErrorState>Couldn't parse that PDF: {state.message}</ErrorState>
      )}

      <ErrorBoundary onReset={reset}>
        {state.phase === "done" && edited && (
          <>
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
            {jdFitEnabled && (
              // Cross-sell sits *below* the result as a quiet follow-on, not a
              // primary-CTA banner above the score: the page's one primary
              // action is the user's parse/score, not navigation to another
              // product. Demoted to a `link` so it doesn't out-shout the result.
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
                <p className="text-sm text-content-secondary">
                  Tailoring this resume to a specific role?
                </p>
                <Button variant="link" size="sm" onClick={goToJdFit}>
                  Check fit against a job →
                </Button>
              </div>
            )}
          </>
        )}
      </ErrorBoundary>
    </PageShell>
  );
}

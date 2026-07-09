// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { Card, Chip, ErrorState, ErrorBoundary, Button } from "@design-system";
import { DropZone } from "./components/DropZone";
import { Result } from "./components/Result";
import { ReconstructedResume } from "./components/features/ReconstructedResume.tsx";
import { AtsScoreReadout } from "./components/features/AtsScoreReadout.tsx";
import { PageShell } from "./components/features/PageShell.tsx";
import { ReplaceResumeDropOverlay } from "./components/features/ReplaceResumeDropOverlay.tsx";
import { ResumeLibrary } from "./components/features/ResumeLibrary.tsx";
import { SaveResumeBar } from "./components/features/SaveResumeBar.tsx";
import { useAnalyzedResume } from "./hooks/useAnalyzedResume.ts";
import { useResumeLibrary } from "./hooks/useResumeLibrary.ts";
import { useReplaceResumeOnDrop } from "./hooks/useReplaceResumeOnDrop.ts";
import { writeJdFitHandoff } from "./lib/jd-fit-handoff.ts";
import { isScoreRevealed } from "./lib/contact.ts";
import { useFlag } from "./lib/flags.ts";

export default function App() {
  const {
    state,
    edit,
    edited,
    displayResult,
    handleFile,
    reset,
    formatBytes,
    startBlank,
    resumeDraft,
    startOverBlank,
    loadSavedResume,
  } = useAnalyzedResume();

  // Local-first resume library (#322) — save/reload parsed resumes without
  // re-uploading. Loading hydrates the "done" state from the cached parse.
  const library = useResumeLibrary();
  const onLoadSavedResume = async (id: string) => {
    const loaded = await library.load(id);
    if (loaded === undefined) return;
    loadSavedResume({
      fileName: loaded.filename,
      fileSize: loaded.fileSize,
      bytes: loaded.bytes,
      sourceKind: loaded.sourceKind,
      result: loaded.result,
      score: loaded.score,
    });
  };

  // Once a parse is done the inline DropZone is gone; this restores drag-and-
  // drop so a new resume can replace the current one (confirm-gated, since it
  // discards the parse + edits). Only armed in "done" — idle/error already show
  // the inline DropZone, which owns drops there.
  const replaceDrop = useReplaceResumeOnDrop({
    enabled: state.phase === "done",
    onFile: handleFile,
  });

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

  // #313 — an unresolved draft prompt (from-scratch authoring, reload with a
  // saved draft present) blocks the editor until the user picks resume vs.
  // start over.
  const showingDraftPrompt =
    state.phase === "authoring" && state.pendingDraft !== null;

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
      {(state.phase === "idle" ||
        state.phase === "parsing" ||
        state.phase === "error") && (
        // Pre-drop landing column fills the same width as the results view
        // (PageShell's max-w-5xl) so dropping a resume doesn't jump the layout
        // width. Prose inside each block is capped (max-w-2xl / max-w-3xl) and
        // centered on the drop-zone axis so line length stays readable even
        // though the surrounding cards span the full column.
        <section className="flex w-full flex-col gap-6">
          {(state.phase === "idle" || state.phase === "error") && (
            // One consolidated hero message (internal #265): a single,
            // non-hyperbolic headline — no "they don't read your PDF" claim and
            // no "parser" jargon — that says what resumelint does in one angle.
            // The trust stat is the one supporting line; everything else (the
            // recruiter-agent context) moves to the quiet block below the drop
            // zone so the hero isn't three competing messages.
            <Card className="flex flex-col items-center gap-5 bg-surface-card-warm">
              <div className="flex max-w-2xl flex-col gap-4 text-center">
                <h2 className="text-balance text-2xl font-normal leading-snug tracking-tight text-content-secondary sm:text-3xl">
                  <span className="font-semibold text-content-primary">
                    AI is now part of most hiring pipelines —
                  </span>{" "}
                  and nearly half of job seekers say they&apos;ve lost trust in
                  a process they can&apos;t see into.
                  <a
                    href="https://www.greenhouse.com/newsroom/an-ai-trust-crisis-70-of-hiring-managers-trust-ai-to-make-faster-and-better-hiring-decisions-only-8-of-job-seekers-call-it-fair"
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    aria-label="Source: Greenhouse, 2025 AI in Hiring Report"
                    className="align-super text-xs text-brand-amber hover:underline"
                  >
                    1
                  </a>
                </h2>
                <p className="text-pretty text-base font-medium text-content-primary sm:text-lg">
                  resumelint shows you what a recruiter or screener reads back
                  from your resume — free, private, and open-source.
                </p>
                <p className="text-xs text-content-muted">
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
              </div>
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
            // Saved-resumes picker (#322) — self-hides when the library is
            // empty. Sits directly beneath the drop zone; loading one restores
            // the results view from its cached parse (no re-upload).
            <ResumeLibrary library={library} onLoad={onLoadSavedResume} />
          )}

          {(state.phase === "idle" || state.phase === "error") && (
            // "Start from scratch" entry point (#313) — a clearly-secondary
            // CTA for a user with no resume yet (or who wants a clean start).
            // Reuses the existing editor/exporter surface (ReconstructedResume
            // + useEditableParse + useDownloadPdf) via the "authoring" phase
            // below; no new dropzone/editor/exporter is introduced.
            <div className="flex justify-center">
              <Button variant="ghost" onClick={startBlank}>
                No resume yet? Build one from scratch →
              </Button>
            </div>
          )}

          {(state.phase === "idle" || state.phase === "error") && (
            // "Screened by an agent" framing (internal #21): the recruiter-side
            // proof point that the mirror positioning stands on. Quiet block
            // below the drop zone — context, never competing with the primary
            // action. Claims stay scoped per the fact-check rulings: privacy is
            // file-scoped, determinism is score-scoped. Per the public-copy
            // policy (internal #24) we never name other products here — the
            // trend is described generically, no links to specific tools.
            <div className="rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
              <p className="mx-auto max-w-3xl text-pretty text-sm text-content-secondary">
                <span className="font-medium text-content-primary">
                  Recruiters are starting to run AI agents over resumes.
                </span>{" "}
                Several products score candidates for recruiters. resumelint is
                the candidate-side
                mirror: it shows you what survives the parse — before you hit
                submit. The score isn&apos;t a verdict on you as a candidate —
                it measures how well a machine can read your resume.
              </p>
            </div>
          )}
        </section>
      )}

      {state.phase === "error" && (
        <ErrorState>Couldn't parse that PDF: {state.message}</ErrorState>
      )}

      <ErrorBoundary onReset={reset}>
        {state.phase === "done" && edited && displayResult && (
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
              result={displayResult}
              score={edited.score}
              bytes={state.bytes}
              sourceKind={state.sourceKind}
              onReset={reset}
              edit={edit}
            />
            {/* Save-to-library affordance (#322) — saves the edited parse +
                source bytes so this resume can be reloaded without re-uploading. */}
            <SaveResumeBar
              library={library}
              fileName={state.fileName}
              bytes={state.bytes}
              sourceKind={state.sourceKind}
              result={displayResult}
              score={edited.score}
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

        {state.phase === "authoring" && showingDraftPrompt && (
          // #313 — a saved draft was detected on entry; never silently
          // restored. The choice is blocking (no editor behind it yet).
          <Card className="flex flex-col items-center gap-4 py-8 text-center">
            <h2 className="text-lg font-semibold text-content-primary">
              Resume your in-progress draft?
            </h2>
            <p className="max-w-prose text-sm text-content-secondary">
              You have an unsaved from-scratch resume from a previous
              session. Pick up where you left off, or start over with a
              blank one.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={startOverBlank}>
                Start over
              </Button>
              <Button variant="primary" onClick={resumeDraft}>
                Resume draft
              </Button>
            </div>
          </Card>
        )}

        {state.phase === "authoring" &&
          !showingDraftPrompt &&
          edited &&
          displayResult && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <Button variant="link" size="sm" onClick={reset}>
                  ← Back
                </Button>
              </div>
              {isScoreRevealed(displayResult, edit.contactOverrides) && (
                <AtsScoreReadout score={edited.score} />
              )}
              <ReconstructedResume
                result={displayResult}
                score={edited.score}
                edit={edit}
              />
            </div>
          )}
      </ErrorBoundary>

      <ReplaceResumeDropOverlay
        isDragging={replaceDrop.isDragging}
        pendingFile={replaceDrop.pendingFile}
        onConfirm={replaceDrop.confirmReplace}
        onCancel={replaceDrop.cancelReplace}
      />
    </PageShell>
  );
}

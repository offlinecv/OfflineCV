// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import {
  Card,
  CapabilityStrip,
  ErrorState,
  ErrorBoundary,
  Button,
} from "@design-system";
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
import { departToJobs } from "./lib/jobs-departure.ts";
import { markDeparture } from "./lib/nav-return.ts";
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
  // the custom-domain "/" base and the "/OfflineCV/" Pages-fallback base.
  const goToJdFit = () => {
    if (state.phase === "done") {
      // The PRISTINE parse + score and the edit state as SEPARATE payloads —
      // /jd-fit re-applies the overrides through its own edit layer (#456).
      // Handing it `edited.parsed` instead baked the edits in irreversibly:
      // added entries arrived indistinguishable from parsed ones.
      writeJdFitHandoff({
        result: state.result,
        score: state.score,
        edit: edit.snapshot,
      });
    }
    // #706: mark the departure so /jd-fit/'s "Parser audit" back control can
    // use a real history.back() instead of pushing a fresh, blank `/`.
    markDeparture();
    window.location.href = `${import.meta.env.BASE_URL}jd-fit/`;
  };

  // The header's "Saved jobs" link (#707) is the second route from `/` into
  // `/jobs/`, and only this surface knows there is a parse to hand over — so
  // `PageShell` asks and `/` answers, with exactly what `FindJobsLauncher`'s
  // button does (`departToJobs`). Without the handoff the library would rate
  // nothing (#700) and tell a user who had just parsed a résumé to "open this
  // workbench from your resume". `PageShell` fires this only on an unmodified
  // primary click, so the marker always accompanies a real navigation.
  const goToSavedJobs = () => {
    departToJobs(displayResult?.canonical.fields);
  };

  // #313 — an unresolved draft prompt (from-scratch authoring, reload with a
  // saved draft present) blocks the editor until the user picks resume vs.
  // start over.
  const showingDraftPrompt =
    state.phase === "authoring" && state.pendingDraft !== null;

  return (
    // `chips` is deliberately NOT passed: PageShell renders that slot in the
    // header on every phase, so the capability strip stayed pinned above the
    // result for the whole session — three lanes the user had already chosen
    // between, restated over their score. It now renders once, below the drop
    // zone, on the pre-drop screen only (see the idle section below).
    // No `subtitle` either. It read "A parser audit for your resume — not a
    // judge", which failed three ways at once: "parser audit" is the internal
    // vocabulary this PR is removing from the tab labels, "not a judge"
    // defends against an objection the visitor has not formed yet, and on the
    // idle screen it was a second tagline sitting two inches above the
    // headline. The one idea worth keeping — the score rates the file, not the
    // person — now lives as a plain sentence in the block below the drop zone,
    // next to the score it qualifies. Dropping it also leaves the star CTA
    // alone on the header-right instead of sharing it. `/jd-fit` and `/jobs`
    // still pass one: they open straight into a form with no headline of their
    // own, so there the header line is the only orientation.
    <PageShell badge="alpha" onSavedJobsNavigate={goToSavedJobs}>
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
            // no "parser" jargon — that says what OfflineCV does in one angle.
            // The supporting context (recruiter-agent framing AND the trust
            // stat that sources it) lives in the quiet block below the drop
            // zone, so the hero is one message, not three.
            //
            // The headline claims custody, NOT runtime — the distinction is
            // load-bearing and must survive edits. "in your browser" scopes the
            // claim to a place; it is NOT an absolute "runs on your device"
            // claim, which would be false: the job-search lane egresses
            // keywords on an explicit click (see FindJobsPanel), a build with
            // VITE_POSTHOG_KEY set (the hosted one) ships analytics, and the
            // BYOK provider path (#320, not in the tree yet — see
            // CapabilityStrip) will be real cloud egress once it lands.
            //
            // "Browser" is also the noun the sibling surfaces use, and the
            // three are read together on the idle screen: CapabilityStrip's
            // rail ("Your resume stays in your browser") renders just below the
            // drop zone, and PageShell's footer states its own
            // narrower, hedged claim about a different object ("your PDF stays
            // in this browser tab by default"). Same noun, three different
            // sentences — if you change the noun in one, change it in all.
            //
            // What is absolute is the subhead's promise — the *resume* never
            // leaves the browser — guaranteed by keywords.ts (only a derived
            // keyword string egresses, never the resume/PDF/queries). That is
            // absolute only while keywords.ts is the sole resume-derived
            // egress: if #320's BYOK path lands, it sends resume text to a
            // cloud provider and this subhead becomes false, so it must be
            // rescoped in the same PR that ships it. Keep the headline about
            // place and the subhead about the resume; do not merge them into a
            // blanket "everything stays on your device."
            // NOT a Card. `bg-surface-card-warm` made this the only tinted
            // surface on the pre-drop screen, so the block a visitor cannot act
            // on out-ranked the one they must (user testing, Jul 2026: "it's
            // kind of hard to find what am I supposed to do here"). Orientation
            // still comes first — a visitor needs to know what this is before a
            // drop zone means anything — but as plain text, in two lines, with
            // the accent reserved for the drop zone directly below.
            //
            // The lane list ("score it, fix it, match a JD, and find jobs") is
            // gone from the subhead because `CapabilityStrip`, a few inches
            // below, enumerates exactly those lanes with descriptions. The
            // Greenhouse citation moved down to the recruiter-agent block,
            // which is the claim it actually sources.
            <div className="mx-auto flex max-w-2xl flex-col gap-2 text-center">
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight text-content-primary sm:text-3xl">
                Your whole job search — in your browser.
              </h2>
              <p className="text-pretty text-base text-content-secondary sm:text-lg">
                A free, open-source job-search workbench — and your resume never
                leaves your browser.
              </p>
            </div>
          )}

          {/* Drop zone + its own alternative, in one tight group. The section's
              `gap-6` is the separation between *topics*; "no resume yet?" is not
              a topic of its own, it is the other way to answer the question the
              drop zone asks, so it sits a `gap-3` away from it rather than
              below the capability strip, the library and the job tracker (user
              testing, Jul 2026: "it is now separated"). Proximity is the whole
              point — a fallback a visitor has to scroll past three unrelated
              blocks to find is a fallback they never see. */}
          <div className="flex flex-col gap-3">
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
          </div>

          {(state.phase === "idle" || state.phase === "error") && (
            // Capability strip, moved out of PageShell's `chips` header slot.
            // Below the drop zone, not above it: it answers "what else does
            // this do?", which is a question a visitor asks *after* the primary
            // action is legible, not before. Pre-drop only — post-parse the
            // user has already picked a lane and the tab strip owns navigation.
            <CapabilityStrip />
          )}

          {(state.phase === "idle" || state.phase === "error") && (
            // Saved-resumes picker (#322) — self-hides when the library is
            // empty, which is why it is not in the drop-zone group above: an
            // invisible block there would leave a phantom gap between the drop
            // zone and its "no resume yet?" fallback. Loading an entry restores
            // the results view from its cached parse (no re-upload).
            <ResumeLibrary library={library} onLoad={onLoadSavedResume} />
          )}

          {(state.phase === "idle" || state.phase === "error") && (
            // The one guarantee a visitor needs before dropping a file, and
            // nothing else. Quiet block below the drop zone: reassurance, never
            // competing with the primary action.
            //
            // Cut to a single line Aug 2026. Two paragraphs went with it and
            // neither should come back here:
            //
            //   1. A product pitch ("OfflineCV parses your resume, shows you
            //      what a machine read back, …"). Accurate, but this is an open
            //      source project — it does not need to sell itself on its own
            //      landing page, and a visitor who wants the description can
            //      read /how-it-works/ (public/how-it-works/index.html), which
            //      is where that sentence now lives in longer form.
            //   2. The Greenhouse "2025 AI in Hiring Report" citation. It
            //      sourced a claim about the hiring industry that this app
            //      never needed to make in order to be useful. People can look
            //      up the state of AI in hiring themselves.
            //
            // What survives is the part that is a *guarantee* rather than a
            // pitch: there is no signup wall, and the score is deterministic.
            // Both round-trip to code — no auth exists anywhere in the tree,
            // and `computeAnonymousAtsScore` in `src/lib/score/score.ts` is a
            // pure function of the extracted text. Determinism stays scoped to
            // the score, never claimed for the parse.
            <div className="rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
              <p className="mx-auto max-w-3xl text-pretty text-sm text-content-secondary">
                No account, no email, results in seconds — and the same file
                always gets the same score.
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
              {isScoreRevealed(displayResult.canonical, edit.contactOverrides) && (
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

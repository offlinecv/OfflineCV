// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { useCallback } from "react";
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
import { JobTrackerSection } from "./components/features/JobTracker.tsx";
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

  // Local job tracker (#323) — flag-gated (default off) while #323 sits at P4.
  // `JobTrackerSection` owns `useJobTracker`, so with the flag off nothing here
  // touches IndexedDB at all.
  const jobTrackerEnabled = useFlag("job-tracker");
  // Resolve a job's linked resume id to a display name, and offer the same
  // library entries to the row's link picker. Both come from the library the
  // page already loads, so the tracker never re-reads the resume store.
  const resumeName = useCallback(
    (resumeId: string) =>
      library.entries.find((entry) => entry.id === resumeId)?.filename,
    [library.entries],
  );

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
    window.location.href = `${import.meta.env.BASE_URL}jd-fit/`;
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
    <PageShell badge="alpha">
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

          {jobTrackerEnabled && (state.phase === "idle" || state.phase === "error") && (
            // Tracked jobs (#323) — sits under the saved-resumes picker, the
            // other local-first surface, so both persistence affordances live
            // in one place. Unlike the library it does NOT self-hide when
            // empty: its empty state carries the only "Add a job" entry point.
            <JobTrackerSection
              resumeName={resumeName}
              resumeOptions={library.entries}
            />
          )}

          {(state.phase === "idle" || state.phase === "error") && (
            // What this is, plainly — plus the three claims displaced from the
            // old trust-chip row (#517: speed, no-signup, determinism) and the
            // citation. Quiet block below the drop zone: context, never
            // competing with the primary action.
            //
            // Rewritten Jul 2026 (user testing: "too long and not clear of its
            // value"). The old copy opened on the *trend* — "recruiters are
            // starting to run AI agents over resumes" — so the first thing a
            // visitor read was someone else's behaviour, and what they
            // personally get arrived in clause four, as a metaphor ("the
            // candidate-side mirror"). It now opens on the three things the
            // product does, in the order a user does them: parse, edit,
            // download. 85 words → 27.
            //
            // The recruiter-trend sentence was cut outright, not demoted, on a
            // second pass: an unhedged "recruiters increasingly screen with AI"
            // is a claim about an industry we would have to defend, and the
            // Greenhouse report below measures AI *trust* among hiring
            // managers, not screening prevalence — it never sourced that
            // sentence as tightly as the old comment here asserted. The
            // citation now stands on its own weaker, supportable claim
            // ("a hiring process job seekers say they can't see into").
            //
            // ⚠️ Cut with it: "the score rates how readable your file is, not
            // how good you are." That framing is now nowhere in the app — the
            // header subtitle that used to carry it ("not a judge") is deleted
            // in this PR too, and `AtsScoreReadout` never stated it. If it
            // comes back, it belongs next to the score, not on the landing.
            //
            // Both export formats are real, so the remaining claim round-trips:
            // PDF via `useDownloadPdf.ts` → `render-ats-pdf.ts`, Markdown via
            // `useDownloadMarkdown.ts` (#552). If either is removed, this
            // sentence moves in the same PR. "A machine", never "the ATS" — we
            // run one generic text extractor (pdfjs), so a definite article
            // would claim a fidelity we have not measured. Determinism stays
            // scoped to the score, not to the parse.
            <div className="rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
              {/* One shared `mx-auto max-w-3xl` wrapper, not three. Applied
                  per-paragraph, `mx-auto` centres each block independently, so
                  a paragraph long enough to wrap reads as left-aligned while a
                  short one visibly centres itself — the three lines rendered
                  with three different left edges. Centring the group once
                  gives them one. */}
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                <p className="text-pretty text-sm font-medium text-content-primary">
                  OfflineCV parses your resume, shows you what a machine read
                  back, and lets you edit it and download a cleanly formatted
                  PDF or Markdown file.
                </p>
                {/* The three claims displaced from the trust-chip row (#517).
                    Muted and on their own line: they are reassurance a visitor
                    scans for, not part of the argument above. */}
                <p className="text-sm text-content-secondary">
                  No account, no email, results in seconds — and the same file
                  always gets the same score.
                </p>
                {/* The trust stat, relocated from the hero. It sources the
                    "recruiters increasingly screen with AI" claim above it,
                    which is what it was always evidence for — in the hero it
                    was a third competing message ahead of the primary action. */}
                <p className="text-sm text-content-muted">
                  Built in response to a hiring process job seekers say they
                  can&apos;t see into — source:{" "}
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

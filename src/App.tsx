// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CapabilityStrip,
  Dialog,
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
import { ShareWithExtensionBar } from "./components/features/ShareWithExtensionBar.tsx";
import { ExportDialog } from "./components/features/ExportDialog.tsx";
import { ResumeChooserDialog } from "./components/features/ResumeChooserDialog.tsx";
import { FeedbackDialog } from "./components/features/FeedbackDialog.tsx";
import { useAnalyzedResume } from "./hooks/useAnalyzedResume.ts";
import { useResumeLibrary } from "./hooks/useResumeLibrary.ts";
import { useReplaceResumeOnDrop } from "./hooks/useReplaceResumeOnDrop.ts";
import { useAutoRestoreResume } from "./hooks/useAutoRestoreResume.ts";
import { useAutosaveResume } from "./hooks/useAutosaveResume.ts";
import { useLlmRecovery } from "./hooks/useLlmRecovery.ts";
import { useFeedbackDialog } from "./hooks/useFeedbackDialog.ts";
import {
  departToJobs,
  departToJobsAndNavigate,
} from "./lib/jobs-departure.ts";
import {
  deriveJourney,
  journeyStage,
  type JourneyStageId,
} from "./lib/journey.ts";
import { useJourneyProgress } from "./hooks/useJourneyProgress.ts";
import { fingerprintParse } from "./lib/tailor-handoff.ts";
import type { LoadedResume } from "./lib/resume-library.ts";
import { isScoreRevealed } from "./lib/contact.ts";
import { SECTION_IDS, scrollToSection } from "./lib/anchors.ts";

export default function App() {
  const {
    state,
    edit,
    edited,
    displayResult,
    parseKey,
    handleFile,
    reset,
    formatBytes,
    startBlank,
    resumeDraft,
    startOverBlank,
    loadSavedResume,
  } = useAnalyzedResume();

  // What a degenerate-parse recovery pass produced (#243), owned HERE since
  // #823 rather than inside `ParsedCard`. Everything that hands the résumé
  // somewhere else runs at this level — the rail's Match-jobs stage, the
  // header's "Saved jobs" link, the export dialog — and while this state lived
  // one level down, none of them could see it: a user who repaired a broken
  // parse with the on-device pass then searched jobs against the fields the
  // parser got wrong. `recovery.activeResult` is the parse the page shows, and
  // it is now the parse every one of those routes uses.
  const recovery = useLlmRecovery(
    displayResult,
    edited?.score ?? null,
    parseKey,
  );
  // The résumé to hand over / export. Null exactly when there is nothing
  // parsed; identical to `displayResult` until a recovery pass lands.
  const activeFields = recovery?.activeResult.canonical.fields;

  // ── The journey completion ledger (#826) ──────────────────────────────────
  //
  // The key is `fingerprintParse` of the PRISTINE parse — `state.result`,
  // before the edit layer and before LLM recovery — and getting that wrong is
  // the one trap in this feature. `fingerprintParse` is used over the
  // EDIT-FOLDED fields everywhere else on purpose (the tailor handoff wants a
  // payload to go stale the moment the résumé changes); a ledger keyed the same
  // way would show `Download ✓` and then lose the mark on the next keystroke.
  // The pristine parse is stable across edits, across a recovery pass, and
  // across a library reload, which is exactly what a completion has to be.
  // While authoring from scratch there is no parse at all, so the key is
  // `parseKey`'s own `authoring:<generation>` string.
  //
  // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
  // CLAUDE.md): `state` is read but `parseKey` is derived from precisely the
  // two members read here (`state.result` and `state.generation`) and is the
  // canonical "a genuinely new résumé is on screen" token, so it covers reset,
  // replace, a library load and a fresh authoring session in one dep.
  const journeyKey = useMemo<string | null>(() => {
    if (state.phase === "done") {
      return fingerprintParse(state.result.canonical.fields);
    }
    if (state.phase === "authoring") return `authoring:${state.generation}`;
    return null;
  }, [parseKey]);
  const progress = useJourneyProgress(journeyKey);

  // `Fix it` means "you edited something", so a clean parse may never complete
  // this stage — which is correct: the user is STANDING on it, so it renders
  // `current` rather than unchecked and nagging. Fires once per résumé, on the
  // first flip to true; `mark` is a no-op for a milestone already recorded.
  // Deps hand-audited: `progress.mark` is memoized on the ledger key alone, so
  // this re-fires exactly when the résumé changes and never on a re-read.
  useEffect(() => {
    if (!edit.hasEdits) return;
    progress.mark("fix");
  }, [edit.hasEdits, progress.mark]);

  // Which artifacts the user can leave with (#823) — one dialog, opened by the
  // rail's Download stage. Owned here, next to the rail that opens it.
  const [exportOpen, setExportOpen] = useState(false);
  // An export dialog cannot outlive the résumé it exports. A replace-drop
  // landing while it is open takes the page through `parsing`, which unmounts
  // the dialog — a flag left set would then re-open it, unasked, over the NEXT
  // résumé. Corrected during render rather than from an effect so there is no
  // committed frame in between for that to be visible in.
  if (recovery === null && exportOpen) setExportOpen(false);

  // The multi-step feedback interstitial (#900) — one controller for both
  // ways in: the ambient `[★ Feedback]` button (threaded through `Result` to
  // `ParsedHeader`) and the automatic trigger, earned below from the export
  // dialog's résumé-only callback and flushed when that dialog closes. Owned
  // here, next to `exportOpen`, since both dialogs are page-level siblings.
  const feedback = useFeedbackDialog();

  // Local-first resume library (#322) — save/reload parsed resumes without
  // re-uploading. Loading hydrates the "done" state from the cached parse.
  const library = useResumeLibrary();

  // Keep the user's work (#824). Nothing is written until an edit exists —
  // dropping a PDF and reading the score leaves no résumé at rest — and from
  // then on the record is kept current without the user remembering to act,
  // exactly as the blank-authoring lane has done since #313. Fed the RECOVERED
  // parse, never `displayResult`: a user who repaired a degenerate parse with
  // the on-device pass must not find the broken version saved over their work.
  const autosave = useAutosaveResume({
    library,
    parseKey,
    hasEdits: edit.hasEdits,
    resume:
      state.phase === "done" && recovery !== null
        ? {
            filename: state.fileName,
            bytes: state.bytes,
            sourceKind: state.sourceKind,
            result: recovery.activeResult,
            score: recovery.activeScore,
          }
        : // Only the parsed lane autosaves to the library. A blank-authoring
          // session is a résumé too, but it already persists through its own
          // localStorage draft (#313) and has no file behind it to store.
          null,
  });

  // The one mapping from a stored record to the "done" state, shared by the
  // explicit Load button below and the cold-mount auto-restore (#812) — two
  // callers of the same hydration must not be able to drift into hydrating
  // different fields.
  const hydrateFromLibrary = useCallback(
    (loaded: LoadedResume) => {
      loadSavedResume({
        fileName: loaded.filename,
        fileSize: loaded.fileSize,
        bytes: loaded.bytes,
        sourceKind: loaded.sourceKind,
        result: loaded.result,
        score: loaded.score,
      });
      // The loaded record's id was dropped here until #824, because nothing
      // downstream wanted it. With autosave on, dropping it mints a SECOND
      // record on the first edit after every restore — one new record per visit,
      // forever. Adopted in the same event as the hydration and keyed by the
      // parse it arrived with, which is the `parseKey` the line above is about
      // to make current. Both restore callers share this function precisely so
      // neither can forget.
      autosave.adopt(loaded.result, loaded.id);
    },
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md): `autosave.adopt`, not `autosave`, whose wrapper object is a
    // fresh literal every render — depending on it would re-mint this callback
    // (and everything keyed on it) on every keystroke, for a function that is a
    // setter with an empty dep array.
    [loadSavedResume, autosave.adopt],
  );
  /**
   * Load a saved résumé and then FINISH the click that asked for it (#826).
   *
   * `stage` is null for the Saved-resumes card's own Load button, which is not
   * resuming anything — it IS the request. For a rail stage it is the whole
   * point of the chooser existing: a user who clicked `Download` with nothing
   * on the page asked to export, not to be shown a list, so the pick lands the
   * résumé AND reopens the intent.
   *
   * Deps hand-audited both directions: `library.load` / `library.setLoadError`
   * rather than `library`, whose wrapper object is a fresh literal every render
   * and would re-mint this (and `onJourneySelect` with it) on every keystroke.
   */
  const loadAndResume = useCallback(
    async (id: string, stage: JourneyStageId | null) => {
      const loaded = await library.load(id);
      if (loaded === undefined) {
        // The one case this reaches: no cached parse AND no stored bytes to
        // rebuild it from (or bytes the PDF cascade can't read) — see
        // `loadResumeFromLibrary`. Say so; the Saved-resumes card otherwise
        // looks like a dead Load button.
        library.setLoadError(
          "Couldn't restore this resume — its saved parse is missing and there's no usable file kept to rebuild it from. Drop the file in again to load it fresh.",
        );
        return;
      }
      hydrateFromLibrary(loaded);
      if (stage === null || stage === "add") return;
      // The freshly loaded fields, not `activeFields` — that is last render's
      // value, and this runs in the continuation of an await, before the
      // hydration above has committed anything.
      const fields = loaded.result.canonical.fields;
      if (stage === "match") {
        departToJobsAndNavigate(fields, fingerprintParse(fields));
        return;
      }
      if (stage === "download") {
        // Safe in the same batch as the hydration: `recovery` is non-null in
        // any render where `displayResult` is, so the render-time guard that
        // closes an orphaned export dialog never sees this half-applied.
        setExportOpen(true);
        return;
      }
      scrollToSection(SECTION_IDS.reconstructed);
    },
    [library.load, library.setLoadError, hydrateFromLibrary],
  );
  const onLoadSavedResume = (id: string) => void loadAndResume(id, null);

  // #812 — bring the most recently saved résumé back on a cold visit, so the
  // journey rail's first stage reads as satisfied instead of claiming progress
  // over an app that silently forgot the user's work. Spent once per page
  // lifetime and only ever from `idle`, so it never fights a drop, a library
  // Load, or a `reset()` — see the hook.
  useAutoRestoreResume({
    phase: state.phase,
    library,
    onRestore: hydrateFromLibrary,
  });

  // Once a parse is done the inline DropZone is gone; this restores drag-and-
  // drop so a new resume can replace the current one (confirm-gated, since it
  // discards the parse + edits). Only armed in "done" — idle/error already show
  // the inline DropZone, which owns drops there.
  const replaceDrop = useReplaceResumeOnDrop({
    enabled: state.phase === "done",
    onFile: handleFile,
  });

  // The header's "Saved jobs" link (#707) is the second route from `/` into
  // `/jobs/`, and only this surface knows there is a parse to hand over — so
  // `PageShell` asks and `/` answers, through the same shared helper the rail's
  // Match-jobs stage calls. Without the handoff the library would rate nothing
  // (#700) and tell a user who had just parsed a résumé to "open this workbench
  // from your resume". `PageShell` fires this only on an unmodified primary
  // click, so the marker always accompanies a real navigation.
  const goToSavedJobs = () => {
    departToJobs(activeFields, journeyKey ?? undefined);
  };

  // #313 — an unresolved draft prompt (from-scratch authoring, reload with a
  // saved draft present) blocks the editor until the user picks resume vs.
  // start over.
  const showingDraftPrompt =
    state.phase === "authoring" && state.pendingDraft !== null;

  // ── The L1 journey rail (#812) ────────────────────────────────────────────
  //
  // Every input is derived during render from state this component already
  // holds. Nothing here may move into a mount-only `useEffect(…, [])`: the
  // `/jobs/` → `/` return leg is a bfcache restore that never remounts the
  // tree, so a rail computed at mount would be frozen at whatever it said
  // before the trip (the #783 defect, and the reason `useTailorHandoff`
  // listens on `pageshow`).

  // JD steering, reported up from `ResultDetail` (which owns
  // `useTailorHandoff` — see the prop's docblock for why it is not lifted).
  const [jdContext, setJdContext] = useState<string | null>(null);

  // The mark is cleared HERE, on the canonical "the résumé genuinely changed"
  // token, rather than by waiting for the reporter to say so. The reporter is
  // not always mounted: `Result` short-circuits to `LimitedParsingCard` on a
  // `fonts_unmappable` parse, and `phase: "authoring"` renders
  // `ReconstructedResume` directly with no `Result` at all — in both cases
  // `displayResult` is non-null, so a `hasResume` re-guard cannot see the
  // staleness either, and the rail would keep claiming Tailor with a ✓ over a
  // different (or blank) résumé for the rest of the page's life. `parseKey` is
  // null in idle/parsing, the pristine `state.result` in done, and
  // `authoring:<generation>` while authoring, so one dep covers reset, replace,
  // blank authoring and the fonts-unmappable branch.
  //
  // It cannot clobber valid steering on the ordinary path. The bfcache return
  // leg from `/jobs/` does not change `parseKey` at all, so this never fires
  // there; and on a cold reload, `useTailorHandoff` reports via a state update
  // scheduled from an effect, which lands in a LATER commit than the one this
  // runs in — so the report always follows the clear rather than being erased
  // by it. Deps hand-audited both directions (`exhaustive-deps` is NOT enforced
  // — CLAUDE.md): `parseKey` is the only input, and `setJdContext` is a
  // React-guaranteed-stable setter that a dep list must not list.
  useEffect(() => {
    setJdContext(null);
  }, [parseKey]);

  // A blank-authoring session counts: a résumé the user is writing from
  // scratch is still a résumé, and `displayResult` is exactly "there is
  // something on screen to fix, match, tailor and download".
  const hasResume = displayResult !== null;
  // #826 — the second, deliberately separate résumé signal. `/jobs/` has
  // answered "does this browser have a résumé" from the library as well as the
  // handoff since #724; `/` answered from memory alone, so after a `Start over`
  // (or on any visit where the cold-mount auto-restore is already spent) the
  // rail read "not ready yet" next to a Saved-resumes card listing three of
  // them. It widens AVAILABILITY only — merging it into `hasResume` would put
  // `current: "fix"` on a page whose body is the drop zone, which is the same
  // unearned claim #826 exists to remove. See `deriveJourney`.
  const hasStoredResume = library.entries.length > 0;
  // No `hasResume &&` guard on the steering: "steering implies a résumé" is
  // normalized inside `deriveJourney` itself now (#812), so it holds for every
  // caller rather than for the two that remembered.
  const journeyState = useMemo(
    () =>
      deriveJourney({
        entry: "root",
        hasResume,
        hasStoredResume,
        jdSteering: jdContext !== null,
        completed: progress.completed,
      }),
    [hasResume, hasStoredResume, jdContext, progress.completed],
  );

  // The stage a click asked for while nothing was on the page, held until the
  // chooser answers it. Cleared when the dialog closes unpicked — a stashed
  // intent that outlived its dialog would fire on the NEXT pick.
  const [pendingStage, setPendingStage] = useState<JourneyStageId | null>(null);

  // #825 — the `Add résumé` stage asked to clear a page whose autosave had not
  // caught up. Held as its own flag rather than folded into `pendingStage`:
  // that one is a stage waiting for a résumé to be CHOSEN, this is a stage
  // waiting for a discard to be AGREED, and the two resolve through different
  // dialogs with opposite consequences.
  const [confirmAddResume, setConfirmAddResume] = useState(false);

  const onJourneySelect = useCallback(
    (id: JourneyStageId) => {
      // The one route off `/` that leaves the document. Through the shared
      // helper, never hand-rolled: a second definition of "hand the parse over
      // and mark the departure" is exactly what shipped #700. `activeFields`,
      // not `displayResult`'s — a recovered parse must not be silently
      // downgraded on the way out (#823).
      if (id === "match" && hasResume) {
        departToJobsAndNavigate(activeFields, journeyKey ?? undefined);
        return;
      }
      // `add` means "put a résumé on this page", and with one already loaded
      // the only thing that satisfies it is the drop zone — which is a
      // `reset()` away, not a scroll (#825). This stage was inert until then:
      // it fell through to the shell's scroll-to-top, so a user standing on
      // `Fix it` and clicking `Add résumé` got a page that had not moved and
      // no way in. The reset it refused to do is the same one `ParsedHeader`'s
      // "Try another file" has always run.
      //
      // What made it look unsafe was written before #824. The autosave has
      // already written every settled edit to the library, so the only work a
      // reset can actually destroy is a write still owed — which is exactly
      // the state the confirm below covers, and exactly the state the header
      // badge is already reporting as "Unsaved changes" / "Saving…". Every
      // other case discards a parse the user can restore from the Saved
      // resumes card, so making them confirm it would be a click tax on the
      // ordinary path.
      if (id === "add") {
        // Nothing loaded: the page already IS the drop zone and the shell has
        // scrolled to it. A `reset()` here would additionally clear an `error`
        // phase's message before the user had read why their file failed.
        if (!hasResume) return;
        if (autosave.state === "unsaved" || autosave.state === "saving") {
          setConfirmAddResume(true);
          return;
        }
        reset();
        return;
      }
      // #826 — every stage below this line needs a résumé to act on, and since
      // the rail reads the saved library too, the click can arrive with none on
      // the page. Resolve by what is actually saved: zero is unreachable (the
      // stage has no availability, so `useJourneyGuidance` shows the guidance
      // card instead of calling this at all), one loads without asking (a
      // picker with a single row is a click tax), and two or more is the one
      // case that genuinely needs the user.
      if (!hasResume) {
        const saved = library.entries;
        if (saved.length === 0) return;
        if (saved.length === 1) {
          void loadAndResume(saved[0]!.id, id);
          return;
        }
        setPendingStage(id);
        return;
      }
      // Download is an ACTION, not a place — it opens the one export dialog
      // rather than moving the page, which is exactly why `journey.ts` refuses
      // to ever mark it `current`.
      if (id === "download") {
        setExportOpen(true);
        return;
      }
      // Fix it and Tailor are the same place: the reconstructed résumé, which
      // holds the editor and the rewrite affordance and is the page body now
      // that #823 took the tab rail off. A plain scroll — the shell scrolled to
      // the top of the page first, and this supersedes it (a new smooth scroll
      // on the same box aborts the one in flight). The landing offset comes
      // from `styles.css`'s `scroll-padding-top`, sized to the sticky header;
      // do not compensate again here.
      scrollToSection(SECTION_IDS.reconstructed);
    },
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md): `library.entries`, not `library`, whose wrapper object is a
    // fresh literal every render; `autosave.state`, not `autosave`, for the
    // same reason — the state string is the only member the `add` branch
    // reads, and depending on the wrapper would re-mint this on every
    // keystroke. `setExportOpen` / `setPendingStage` / `setConfirmAddResume`
    // are React-guaranteed-stable setters a dep list must not list.
    [
      activeFields,
      journeyKey,
      hasResume,
      library.entries,
      loadAndResume,
      autosave.state,
      reset,
    ],
  );

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
    // alone on the header-right instead of sharing it. `/jobs` still passes
    // one: it opens straight into a form with no headline of its own, so
    // there the header line is the only orientation.
    <PageShell
      badge="alpha"
      onSavedJobsNavigate={goToSavedJobs}
      journey={{ state: journeyState, onSelect: onJourneySelect }}
      onOpenFeedback={feedback.openDialog}
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
            //
            // `mt-6` is the ONE place on either entry that opts out of the
            // shell's uniform 24px section rhythm, doubling it to 48px. The
            // extra air is what makes the header band read as chrome and this
            // as the start of the page, and it is deliberately not spent on
            // any other section: a page where everything is emphasised
            // emphasises nothing. It rides the headline block rather than the
            // `<section>` around it because the section also renders during
            // `parsing`, when the headline does not.
            <div className="mx-auto mt-6 flex max-w-2xl flex-col gap-2 text-center">
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
        {state.phase === "done" && edited && displayResult && recovery && (
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
              //
              // This is the pre-LLM-override parse; the one the surface renders
              // (plus its score and its identity token) travels in `recovery`.
              result={displayResult}
              bytes={state.bytes}
              sourceKind={state.sourceKind}
              onReset={reset}
              edit={edit}
              recovery={recovery}
              parseKey={parseKey}
              autosave={autosave}
              onJdContextChange={setJdContext}
              // #826 — a whole-résumé rewrite applied while a JD was steering
              // it IS the Tailor stage, done. `ResultDetail` owns the pairing;
              // the key it is recorded under is only knowable here.
              onTailorApplied={() => progress.mark("tailor")}
              // #900 — ambient feedback button trigger.
              onOpenFeedback={feedback.openDialog}
            />
            {/* Hand the parse to the capture extension (#620) — self-hides when
                no extension answers a probe, so it costs nothing on the visit
                of everyone who runs none. `recovery.activeResult`, on the same
                terms as every other consumer: this ships the résumé OUT of the
                page, so a pre-recovery parse here would have the extension rate
                every captured posting against the fields the parser got wrong,
                with nothing on screen to reveal it. Same shape `departToJobs`
                hands `/jobs/`, and now the same value; the file name becomes
                the label the extension's panel shows beside its rating. */}
            <ShareWithExtensionBar
              parsed={recovery.activeResult.canonical.fields}
              fileName={state.fileName}
            />
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

      {recovery && (
        // The one export surface (#823) — PDF, Markdown and the audit report,
        // each row naming its artifact. Mounted at page level rather than
        // inside the result tree because the rail that opens it is up here too,
        // and because the authoring lane (which renders no `Result` at all)
        // needs the same three exports. Exports the RECOVERED parse, so the
        // artifact matches what the page shows.
        <ExportDialog
          open={exportOpen}
          // #900 — closing is also when a pending feedback milestone flushes.
          // The export dialog stays open after a download on purpose (#421),
          // so opening the interstitial any earlier would stack a second
          // native modal over the findings the download just produced.
          onClose={() => {
            setExportOpen(false);
            feedback.notifyExportClosed();
          }}
          result={recovery.activeResult}
          score={recovery.activeScore}
          contactOverrides={edit.contactOverrides}
          // #826 — any of the three artifacts reaching the user completes the
          // Download stage, the audit report included: the ledger records that
          // the user went through here, and the report is downloaded from it.
          onExported={() => progress.mark("download")}
          // #900 — the résumé-only subset of the same success point feeds the
          // feedback dialog's automatic first-export trigger.
          onResumeExported={feedback.notifyResumeExported}
        />
      )}

      {/* #900 — the multi-step feedback interstitial. Page level, beside the
          export dialog whose résumé-only callback can open it automatically. */}
      <FeedbackDialog
        open={feedback.open}
        onClose={feedback.close}
        onSubmitted={feedback.markSubmitted}
      />

      {/* #826 — which saved résumé did you mean? Opened only by a rail click
          that arrived with nothing on the page and two or more saved, and it
          FINISHES that click rather than merely loading (see the file). Page
          level, beside the export dialog it may itself open. */}
      <ResumeChooserDialog
        stage={pendingStage === null ? null : journeyStage(pendingStage)}
        entries={library.entries}
        onPick={(id) => {
          const stage = pendingStage;
          setPendingStage(null);
          if (stage !== null) void loadAndResume(id, stage);
        }}
        onClose={() => setPendingStage(null)}
      />

      {/* #825 — the one case where `Add résumé` is destructive: a write the
          autosave still owes. Same shape and same verb pairing as the
          drag-to-replace confirm below (keep / go ahead), because it is the
          same decision arriving from a different control; it is a separate
          Dialog only because that one is about a specific dropped FILE and
          names it, while this one has no file yet. */}
      <Dialog
        open={confirmAddResume}
        onClose={() => setConfirmAddResume(false)}
        title="Add a different résumé?"
        className="w-[min(24rem,calc(100vw-2rem))]"
      >
        <p className="text-sm text-content-secondary">
          Your latest changes haven&apos;t finished saving to this browser yet.
          Adding another résumé clears this page, and those changes go with it.
          Everything saved before them stays in Saved resumes.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmAddResume(false)}>
            Keep this one
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmAddResume(false);
              reset();
            }}
          >
            Add another résumé
          </Button>
        </div>
      </Dialog>

      <ReplaceResumeDropOverlay
        isDragging={replaceDrop.isDragging}
        pendingFile={replaceDrop.pendingFile}
        onConfirm={replaceDrop.confirmReplace}
        onCancel={replaceDrop.cancelReplace}
      />
    </PageShell>
  );
}

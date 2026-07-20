// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAnalyzedResume — the full parse → edit → re-grade orchestration that both
 * root surfaces share.
 *
 * Extracted from App.tsx (issue #226) so the parser-audit surface (`/`) and the
 * JD-fit surface (`/jd-fit`) drive the SAME pipeline rather than forking it:
 *
 *   useResumeAnalysis (parse state machine)  +
 *   useEditableParse  (inline-edit overrides) +
 *   the `edited` memo (applyOverrides → re-score)  +
 *   the "clear edits on a fresh parse" effect
 *
 * `edited` is the override-applied `{ parsed, rawText, score }` (or null when no
 * parse has landed) — the same shape the `<Result>` component consumes. Callers
 * pass `{ ...state.result, parsed: edited.parsed }` + `edited.score` to Result,
 * exactly as App.tsx did before this lift.
 *
 * Issue #313 (from-scratch authoring) generalizes this: the "authoring" phase
 * runs the EXACT same applyOverrides → re-grade pipeline, just seeded from
 * `buildBlankResult()` (or a restored draft's overrides) instead of a parsed
 * upload. `displayResult` is the one CascadeResult either root surface hands
 * to `Result` / `ReconstructedResume`, so App.tsx never has to know which
 * base it came from.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  useResumeAnalysis,
  writeBlankDraft,
  clearBlankDraft,
  type ParseState,
  type LoadedDoneState,
} from "./useResumeAnalysis.ts";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import {
  applyOverrides,
  applyProfileOverrides,
  type LegacyLinkFields,
} from "../lib/edit/apply-overrides.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import type {
  CascadeResult,
  HeuristicParsedResume,
  FieldConfidence,
} from "../lib/heuristics/types.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { projectScoreSections } from "../lib/heuristics/projections.ts";

export interface EditedResume {
  parsed: HeuristicParsedResume;
  rawText: string;
  score: AnonymousAtsScore;
  /** Edited per-field confidence (user-affirmed contact edits bumped to
   *  present). Threaded onto `displayResult` so the ContactCard's
   *  "GitHub satisfies Professional profile" gap reads the same edited
   *  confidence the score did (#421 Blocking #3). */
  fieldConfidence: FieldConfidence;
}

export interface AnalyzedResume {
  state: ParseState;
  edit: EditableParse;
  /** Override-applied parsed + re-graded score, or null when there's nothing
   *  to show yet (idle/parsing/error, or an unresolved draft prompt). */
  edited: EditedResume | null;
  /** The full CascadeResult to hand to `Result` / `ReconstructedResume`: the
   *  original parse (phase "done") or the blank base (phase "authoring"),
   *  with `edited.parsed` folded in. Null exactly when `edited` is null. */
  displayResult: CascadeResult | null;
  handleFile: (file: File) => Promise<void>;
  reset: () => void;
  formatBytes: (n: number) => string;
  /** Enter the from-scratch authoring flow (#313). */
  startBlank: () => void;
  /** Resume a previously-detected draft: replays its overrides into `edit`,
   *  then dismisses the prompt. No-op outside an unresolved draft prompt. */
  resumeDraft: () => void;
  /** Discard a previously-detected draft and start a fresh blank resume.
   *  No-op outside an unresolved draft prompt. */
  startOverBlank: () => void;
  /** Hydrate the results view from a saved resume (#322) — no re-parse. */
  loadSavedResume: (saved: LoadedDoneState) => void;
}

export function useAnalyzedResume(): AnalyzedResume {
  const {
    state,
    handleFile,
    reset,
    formatBytes,
    startBlank,
    resolveDraftPrompt,
    startOverBlank,
    loadSavedResume,
  } = useResumeAnalysis();

  // Lifted edit state (#82): overrides live ABOVE the scorer so a corrected
  // name/title/company/bullet re-grades the ATS score + JD coverage, not just
  // the display. Cleared on a new file (or a fresh blank session) via the
  // effect below.
  const edit = useEditableParse();
  const {
    resetAll,
    contactOverrides,
    experienceOverrides,
    bulletOverrides,
    descriptionOverrides,
    removedBullets,
    educationOverrides,
    achievementOverrides,
    skillsOverride,
    addedEntries,
    addedBullets,
    profileOverrides,
  } = edit;

  // The base CascadeResult overrides fold onto: the original parse in "done",
  // a fresh `buildBlankResult()` once an authoring session has no pending
  // draft prompt to resolve first, or null otherwise (nothing to edit yet).
  const pendingDraft = state.phase === "authoring" ? state.pendingDraft : null;
  const base = useMemo<CascadeResult | null>(() => {
    if (state.phase === "done") return state.result;
    if (state.phase === "authoring" && pendingDraft === null) {
      return buildBlankResult();
    }
    return null;
  }, [state.phase, state.phase === "done" ? state.result : null, pendingDraft]);

  // Memoized (#428): an unmemoized `[]` fallback here would mint a fresh array
  // reference on every render while authoring/idle, defeating the `score`
  // memo split below on any unrelated re-render, not just a real edit.
  const doneScoreBullets = useMemo(
    () => (state.phase === "done" ? state.score.bullets ?? [] : []),
    [state.phase === "done" ? state.score.bullets : null],
  );

  // Fold overrides back into a fresh { parsed, rawText, sections,
  // fieldConfidence } — the display-facing view every consumer (ContactCard,
  // displayResult, the eventual PDF/JSON export) reads. This always reruns on
  // ANY override change, including a non-scoring profile add, so `profiles[]`
  // and the other edited fields stay live.
  const editedCore = useMemo(() => {
    if (base === null) return null;
    return applyOverrides(
      base.canonical.fields,
      base.rawText,
      base.canonical.sections,
      contactOverrides,
      experienceOverrides,
      bulletOverrides,
      doneScoreBullets,
      educationOverrides,
      skillsOverride,
      addedEntries,
      addedBullets,
      removedBullets,
      profileOverrides,
      base.canonical.fieldConfidence,
      achievementOverrides,
      descriptionOverrides,
    );
  }, [
    base,
    doneScoreBullets,
    contactOverrides,
    experienceOverrides,
    bulletOverrides,
    descriptionOverrides,
    educationOverrides,
    achievementOverrides,
    skillsOverride,
    addedEntries,
    addedBullets,
    removedBullets,
    profileOverrides,
  ]);

  // The slice of `profileOverrides`' effect the scorer actually reads (#428):
  // only the linkedin_url/github_url legacy slots + their confidence move
  // completeness (see `contact-profiles.ts` — a code/social profile beyond
  // those two, or an extra that doesn't back-fill an empty slot, never
  // reaches the scorer). Probed against a cheap 4-field object — never the
  // full parsed resume — via the SAME `applyProfileOverrides` step
  // `editedCore` runs, so "did this move the score" can never drift from what
  // the real override does.
  const scoreAffectingProfileSlots = useMemo(() => {
    if (base === null) return null;
    const probe: LegacyLinkFields = {
      linkedin_url: base.canonical.fields.linkedin_url,
      github_url: base.canonical.fields.github_url,
      portfolio_url: base.canonical.fields.portfolio_url,
      website_url: base.canonical.fields.website_url,
    };
    const confEdits = applyProfileOverrides(probe, profileOverrides);
    return {
      linkedin_url: probe.linkedin_url,
      github_url: probe.github_url,
      linkedinConfidence: confEdits.find((e) => e.key === "linkedin_url")
        ?.confidence,
      githubConfidence: confEdits.find((e) => e.key === "github_url")
        ?.confidence,
    };
  }, [base, profileOverrides]);

  // Re-grade live. Deps deliberately mirror `editedCore`'s EXCEPT
  // `profileOverrides` is replaced by `scoreAffectingProfileSlots` — so
  // adding a non-scoring profile (Behance, GitLab, a second GitHub that
  // doesn't back-fill an empty slot, …) recomputes `editedCore` for display
  // but leaves this memo — and the identical-numbers regrade it would
  // otherwise trigger — untouched (#428).
  //
  // INVARIANT (hand-maintained — a future add-a-channel PR must uphold both
  // directions): every `editedCore` change that moves the score must ALSO
  // change one of the `scoreAffectingProfileSlots.*` primitives below, and a
  // change that does NOT move the score must leave them identical. Today this
  // holds because those four primitives run the SAME `applyProfileOverrides`
  // step `editedCore` does, over the same `[base, profileOverrides]` pair. If
  // you widen `applyProfileOverrides` to touch a new confidence slot (e.g.
  // `portfolio_url`), widen `scoreAffectingProfileSlots` in lockstep or the
  // score silently returns a stale value for that channel. The object-identity
  // tests pin both directions: a non-scoring profile edit keeps the score
  // object-identical; a scoring correction produces a NEW score reference.
  const score = useMemo(() => {
    if (base === null || editedCore === null) return null;
    // The anonymous scorer pools its bullet set from `sections` (#133), so the
    // edited section view — not the original — must feed re-grading or a live
    // bullet edit would not move Specificity / Structure. `fieldConfidence` is
    // the edited view (contact edits + added linkedin/github bumped to present),
    // so a user-added professional profile moves completeness (#421).
    return computeAnonymousAtsScore({
      parsed: editedCore.fields,
      fieldConfidence: editedCore.fieldConfidence,
      triggers: base.triggers,
      rawText: editedCore.rawText,
      // Score projection off the edited canonical model (`editedCore` IS the
      // mutated CanonicalResume as of #445).
      sections: projectScoreSections(editedCore),
    });
    // `editedCore` is deliberately NOT a dep: this memo reads its latest
    // value whenever it actually runs, but must not re-run on an
    // `editedCore` change driven solely by a non-scoring profile edit —
    // `scoreAffectingProfileSlots` stands in for `profileOverrides` for
    // exactly that reason.
  }, [
    base,
    doneScoreBullets,
    contactOverrides,
    experienceOverrides,
    bulletOverrides,
    educationOverrides,
    achievementOverrides,
    skillsOverride,
    addedEntries,
    addedBullets,
    removedBullets,
    // Primitive fields, not the wrapper object — `scoreAffectingProfileSlots`
    // is a fresh object literal every time `profileOverrides` changes, so
    // depending on ITS reference would defeat the whole point (#428).
    scoreAffectingProfileSlots?.linkedin_url,
    scoreAffectingProfileSlots?.github_url,
    scoreAffectingProfileSlots?.linkedinConfidence,
    scoreAffectingProfileSlots?.githubConfidence,
  ]);

  const edited = useMemo<EditedResume | null>(() => {
    if (editedCore === null || score === null) return null;
    return {
      parsed: editedCore.fields,
      rawText: editedCore.rawText,
      score,
      fieldConfidence: editedCore.fieldConfidence,
    };
  }, [editedCore, score]);

  const displayResult = useMemo<CascadeResult | null>(() => {
    if (base === null || edited === null) return null;
    // Fold the edited fields + confidence back onto the base result's canonical
    // model. `sections` (and `rawText`) stay the base's — display never showed
    // the edited section pool or rawText, only the edited parsed fields (#445).
    return {
      ...base,
      canonical: {
        ...base.canonical,
        fields: edited.parsed,
        fieldConfidence: edited.fieldConfidence,
      },
    };
  }, [base, edited]);

  // Clear edits whenever a fresh parse lands (new file, reset) or a fresh
  // blank-authoring session starts. Resuming a saved draft must NOT clear —
  // `resumeDraft` below replays the draft's overrides BEFORE dismissing the
  // prompt, and this key is keyed on `generation` ALONE (not on whether
  // `pendingDraft` is still showing), so the prompt→resume transition never
  // changes it: `generation` is already set the moment `startBlank()` runs
  // (before the prompt even renders) and stays fixed across `resolveDraftPrompt`.
  // Only a genuinely fresh session (no draft found, or explicit start-over)
  // mints a new `generation`, which is what actually changes this key.
  const resetKey =
    state.phase === "done"
      ? state.result
      : state.phase === "authoring"
        ? `authoring:${state.generation}`
        : null;
  useEffect(() => {
    resetAll();
  }, [resetKey, resetAll]);

  // Autosave the in-progress blank draft (#313), debounced on edit. Only
  // while the authoring editor is actually mounted (no pending prompt) — a
  // draft with zero edits is cleared rather than persisted, so reloading
  // right after "Start from scratch" never manufactures a ghost prompt.
  useEffect(() => {
    if (state.phase !== "authoring" || state.pendingDraft !== null) return;
    if (!edit.hasEdits) {
      clearBlankDraft();
      return;
    }
    const timer = setTimeout(() => writeBlankDraft(edit.snapshot), 500);
    return () => clearTimeout(timer);
    // `edit.snapshot` is memoized on every override map, so it is the one dep
    // that stands for all of them — it changes exactly when the draft does.
  }, [
    state.phase,
    state.phase === "authoring" ? state.pendingDraft : null,
    edit.hasEdits,
    edit.snapshot,
  ]);

  const resumeDraft = useCallback(() => {
    if (state.phase !== "authoring" || !state.pendingDraft) return;
    edit.replay(state.pendingDraft);
    resolveDraftPrompt();
  }, [state, edit, resolveDraftPrompt]);

  return {
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
  };
}

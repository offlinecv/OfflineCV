// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAnalyzedResume — the full parse → edit → re-grade orchestration on `/`.
 *
 * Originally extracted from App.tsx (issue #226) to let a second surface
 * drive the SAME pipeline rather than forking it. The second surface has
 * since been retired (#576), so today `/` is the sole consumer — the
 * extraction remains because a future cross-surface use may want the same
 * seam.
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
 * upload. `displayResult` is the one CascadeResult the root surface hands to
 * `Result` / `ReconstructedResume`, so App.tsx never has to know which base
 * it came from.
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
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import {
  editBaseFromResult,
  foldEditedIntoResult,
  probeScoringProfileSlots,
} from "../lib/edit/edit-pipeline.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { scoreEditedResume } from "../lib/edit/score-edited.ts";
import type {
  CascadeResult,
  HeuristicParsedResume,
  FieldConfidence,
} from "../lib/heuristics/types.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";

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
  /**
   * Opaque identity token for the CURRENT parse — changes exactly when a
   * genuinely new résumé lands (a fresh file, a résumé restored from the
   * library, a new blank-authoring session) and NOT when the user edits one.
   *
   * `displayResult` cannot serve this role and the distinction matters: it is
   * a memo over the override maps, so a single keystroke mints a fresh object
   * with the same parse behind it. Anything downstream that must reset "when
   * the résumé changed" has to key on this instead — see `ResultDetail`'
   * JD-steering reset (#576). Null while there is nothing parsed.
   */
  parseKey: unknown;
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
    removedBullets,
    removedEntries,
    educationOverrides,
    achievementOverrides,
    certificationOverrides,
    skillsOverride,
    summaryOverride,
    addedEntries,
    addedBullets,
    profileOverrides,
    snapshot,
  } = edit;
  // `descriptionOverrides` is deliberately NOT pulled out here: since #652 every
  // override map reaches `applyOverrides` through `snapshot`, and the only
  // reason to name one individually is to list it as a `score` dep below.
  // `descriptionOverrides` is not one of those — it was not a `score` dep before
  // #652 either, and the `score` dep list is unchanged by that refactor.
  // (`editedCore`'s deps DID change — 14 named override maps collapsed to
  // `[base, doneScoreBullets, snapshot]` — but equivalently, because
  // `useEditableParse` memoizes `snapshot` over exactly those same 14.)

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
      editBaseFromResult(base, doneScoreBullets),
      snapshot,
    );
    // `snapshot` is `useEditableParse`'s own memo over EVERY override map, so
    // it changes exactly when one of them does — the same set of re-runs the
    // fourteen individually-listed maps used to spell out. Handing the whole
    // snapshot to `applyOverrides` (#652) is what makes "the fold sees every
    // channel the snapshot carries" true by construction rather than by a
    // nineteen-argument call staying in step with a fourteen-field type.
  }, [base, doneScoreBullets, snapshot]);

  // The slice of `profileOverrides`' effect the scorer actually reads (#428) —
  // see `probeScoringProfileSlots` for why it runs the real
  // `applyProfileOverrides` step rather than a predicate that could drift from
  // it. Null while there is nothing parsed, so the `score` memo below can hold
  // its four primitives unconditionally.
  const scoreAffectingProfileSlots = useMemo(() => {
    if (base === null) return null;
    return probeScoringProfileSlots(base.canonical.fields, profileOverrides);
  }, [base, profileOverrides]);

  // Every key the two bullet maps already hold, so the re-graded pool allocates
  // AROUND them instead of re-minting an id an existing instruction is filed
  // under (#648 — see `bullet-id.ts`). Both maps are already deps of the `score`
  // memo below, so this adds no re-grade the score didn't already do.
  const claimedBulletKeys = useMemo(
    () => [...Object.keys(bulletOverrides), ...removedBullets],
    [bulletOverrides, removedBullets],
  );

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
  //
  // CHANNELS KNOWINGLY ABSENT FROM THE DEP LIST BELOW — read this before adding
  // one. Until #652, `editedCore`'s dep list spelled out the same fourteen maps
  // and sat directly above this one, so an omission was visible by diffing the
  // two arrays. `editedCore` is now `[base, doneScoreBullets, snapshot]`: a new
  // override channel joins the FOLD automatically and joins this memo only by
  // hand, so the omission has no local signal at all. Hence this list:
  //   - `profileOverrides` — deliberate, replaced by
  //     `scoreAffectingProfileSlots` per the invariant above (#428).
  //   - `descriptionOverrides` — a KNOWN PRE-EXISTING BUG, not a decision. It
  //     moves `editedCore` and can move the score (an edited description feeds
  //     the bullet pool), but it was never a dep here and #652 did not change
  //     that. Left as-is on purpose: fixing it is its own change with its own
  //     repro, not a refactor's drive-by.
  // Anything else absent from the array below is unaccounted for — either add
  // it or add it to this list with the reason.
  const score = useMemo(() => {
    if (base === null || editedCore === null) return null;
    // The anonymous scorer pools its bullet set from `sections` (#133), so the
    // edited section view — not the original — must feed re-grading or a live
    // bullet edit would not move Specificity / Structure. `fieldConfidence` is
    // the edited view (contact edits + added linkedin/github bumped to present),
    // so a user-added professional profile moves completeness (#421).
    // Score projection off the edited canonical model (`editedCore` IS the
    // mutated CanonicalResume as of #445), through the shared recipe the
    // corpus edit-leg gate also runs — see `score-edited.ts` for why grading
    // the BASE sections instead silently drops an edited bullet from the export.
    return scoreEditedResume(editedCore, base.triggers, claimedBulletKeys);
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
    certificationOverrides,
    skillsOverride,
    // Completeness reads `parsed.summary` (the >=20-char threshold), so an
    // edited summary MUST re-grade — this dep is what makes #625 AC4 hold.
    summaryOverride,
    addedEntries,
    addedBullets,
    removedBullets,
    // Deleting a parsed entry moves the score twice over (#856): Completeness
    // counts `experience`/`education` entries, and a title-only entry's own
    // pooled line leaves `sections` with it. Both are `editedCore` effects, so
    // this dep is what the hand-maintained invariant above demands.
    removedEntries,
    // Derived from `bulletOverrides` + `removedBullets`, both already above, so
    // this dep adds no re-grade of its own — listed because the memo reads it.
    claimedBulletKeys,
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
    return foldEditedIntoResult(base, edited.parsed, edited.fieldConfidence);
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
  //
  // Exported as `parseKey` as well (#576): "a genuinely new résumé is on
  // screen" is the same question the JD-steering reset downstream has to
  // answer, and the answer has exactly one correct definition. Two hand-rolled
  // approximations of it would be free to drift — and the obvious
  // approximation (`displayResult` identity) is already wrong, since it
  // changes on every edit.
  const parseKey =
    state.phase === "done"
      ? state.result
      : state.phase === "authoring"
        ? `authoring:${state.generation}`
        : null;
  useEffect(() => {
    resetAll();
  }, [parseKey, resetAll]);

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
    parseKey,
    handleFile,
    reset,
    formatBytes,
    startBlank,
    resumeDraft,
    startOverBlank,
    loadSavedResume,
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 */

import { useEffect, useMemo } from "react";
import {
  useResumeAnalysis,
  type ParseState,
} from "./useResumeAnalysis.ts";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";

export interface EditedResume {
  parsed: HeuristicParsedResume;
  rawText: string;
  score: AnonymousAtsScore;
}

export interface AnalyzedResume {
  state: ParseState;
  edit: EditableParse;
  /** Override-applied parsed + re-graded score, or null when no parse is done. */
  edited: EditedResume | null;
  handleFile: (file: File) => Promise<void>;
  reset: () => void;
  formatBytes: (n: number) => string;
}

export function useAnalyzedResume(): AnalyzedResume {
  const { state, handleFile, reset, formatBytes } = useResumeAnalysis();

  // Lifted edit state (#82): overrides live ABOVE the scorer so a corrected
  // name/title/company/bullet re-grades the ATS score + JD coverage, not just
  // the display. Cleared on a new file via the effect below.
  const edit = useEditableParse();
  const { resetAll } = edit;

  // Fold overrides back into a fresh { parsed, rawText } and re-grade live.
  // When `state` isn't "done" there's nothing to apply — the memo returns null
  // and the original score is used as-is.
  const edited = useMemo<EditedResume | null>(() => {
    if (state.phase !== "done") return null;
    const observations = state.score.bullets ?? [];
    const { parsed, rawText, sections } = applyOverrides(
      state.result.parsed,
      state.result.rawText,
      state.result.sections,
      edit.contactOverrides,
      edit.experienceOverrides,
      edit.bulletOverrides,
      observations,
      edit.educationOverrides,
      edit.skillsOverride,
      edit.addedEntries,
      edit.addedBullets,
      edit.removedBullets,
    );
    // The anonymous scorer pools its bullet set from `sections` (#133), so the
    // edited section view — not the original — must feed re-grading or a live
    // bullet edit would not move Specificity / Structure.
    const score = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: state.result.fieldConfidence,
      triggers: state.result.triggers,
      rawText,
      sections,
    });
    return { parsed, rawText, score };
  }, [
    state,
    edit.contactOverrides,
    edit.experienceOverrides,
    edit.bulletOverrides,
    edit.educationOverrides,
    edit.skillsOverride,
    edit.addedEntries,
    edit.addedBullets,
    edit.removedBullets,
  ]);

  // Clear edits whenever a fresh parse lands (new file or reset).
  useEffect(() => {
    resetAll();
    // Keying on the parsed object identity: a new parse → new reference.
  }, [state.phase === "done" ? state.result : null, resetAll]);

  return { state, edit, edited, handleFile, reset, formatBytes };
}

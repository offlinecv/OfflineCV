// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useJdFitResume — resolve the résumé source for `/jd-fit` (issue #226).
 *
 * Two sources collapse to ONE `{ result, score, edit, parsed, ... }` shape that
 * `<Result>` and the JD coverage memo consume identically:
 *
 *  1. Handoff from `/` — the parser-audit surface stashed an already-parsed +
 *     edited résumé in sessionStorage (read once on mount). JD-fit re-grades it
 *     live through its OWN edit layer so inline edits here move the score + JD
 *     coverage, exactly as on `/`.
 *  2. Local DropZone parse — when there's no handoff, the user drops a PDF here
 *     and `useAnalyzedResume` drives the parse → edit → re-grade pipeline.
 *
 * The handoff is consumed once (read + cleared on mount), so a manual reload of
 * /jd-fit falls back to the DropZone rather than re-showing a stale résumé.
 */

import { useEffect, useMemo, useState } from "react";
import type { AnalyzedResume } from "../hooks/useAnalyzedResume.ts";
import { useEditableParse, type EditableParse } from "../hooks/useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../lib/heuristics/types.ts";
import {
  consumeJdFitHandoff,
  type JdFitHandoff,
} from "../lib/jd-fit-handoff.ts";

export interface JdFitResume {
  /** Edited CascadeResult ({ ...result, parsed }) for `<Result>`. */
  result: CascadeResult;
  /** Re-graded anonymous ATS score. */
  score: AnonymousAtsScore;
  /** Edited parsed résumé — fed straight into JD coverage. */
  parsed: HeuristicParsedResume;
  /** PDF bytes for the source pane — only the local path has them. */
  bytes?: ArrayBuffer;
  sourceKind: "pdf" | "docx";
  /** Live inline-edit state threaded into `<Result>`. */
  edit: EditableParse;
  /** Clear the résumé (handoff: back to DropZone; local: reset parse). */
  reset: () => void;
}

export function useJdFitResume(analyzed: AnalyzedResume): JdFitResume | null {
  // Read the one-shot handoff exactly once, on mount.
  const [handoff, setHandoff] = useState<JdFitHandoff | null>(null);
  useEffect(() => {
    setHandoff(consumeJdFitHandoff());
  }, []);

  // The handoff résumé gets its own edit layer so edits on /jd-fit re-grade,
  // mirroring useAnalyzedResume's `edited` memo but seeded from the rehydrated
  // result rather than a fresh parse.
  const handoffEdit = useEditableParse();
  const handoffEdited = useMemo(() => {
    if (!handoff) return null;
    const base = handoff.result;
    const observations = handoff.score.bullets ?? [];
    const { parsed, rawText, sections } = applyOverrides(
      base.parsed,
      base.rawText,
      base.sections,
      handoffEdit.contactOverrides,
      handoffEdit.experienceOverrides,
      handoffEdit.bulletOverrides,
      observations,
      handoffEdit.educationOverrides,
      handoffEdit.skillsOverride,
      handoffEdit.addedEntries,
      handoffEdit.addedBullets,
      handoffEdit.removedBullets,
      handoffEdit.profileOverrides,
    );
    const score = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: base.fieldConfidence,
      triggers: base.triggers,
      rawText,
      sections,
    });
    return { result: { ...base, parsed }, score, parsed };
  }, [
    handoff,
    handoffEdit.contactOverrides,
    handoffEdit.experienceOverrides,
    handoffEdit.bulletOverrides,
    handoffEdit.educationOverrides,
    handoffEdit.skillsOverride,
    handoffEdit.addedEntries,
    handoffEdit.addedBullets,
    handoffEdit.removedBullets,
    handoffEdit.profileOverrides,
  ]);

  // Handoff wins when present. Dropping it (reset) reveals the local DropZone.
  if (handoff && handoffEdited) {
    return {
      result: handoffEdited.result,
      score: handoffEdited.score,
      parsed: handoffEdited.parsed,
      bytes: undefined,
      sourceKind: "pdf",
      edit: handoffEdit,
      reset: () => {
        handoffEdit.resetAll();
        setHandoff(null);
      },
    };
  }

  // Local DropZone path.
  const { state, edited, edit, reset } = analyzed;
  if (state.phase === "done" && edited) {
    return {
      result: { ...state.result, parsed: edited.parsed },
      score: edited.score,
      parsed: edited.parsed,
      bytes: state.bytes,
      sourceKind: state.sourceKind,
      edit,
      reset,
    };
  }

  return null;
}

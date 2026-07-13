// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useJdFitResume — resolve the résumé source for `/jd-fit` (issue #226).
 *
 * Two sources collapse to ONE `{ result, score, edit, parsed, ... }` shape that
 * `<Result>` and the JD coverage memo consume identically:
 *
 *  1. Handoff from `/` — the parser-audit surface stashed the PRISTINE parse
 *     plus the user's edit snapshot in sessionStorage (read once on mount).
 *     JD-fit replays those edits into its OWN edit layer and applies them here,
 *     so inline edits move the score + JD coverage exactly as on `/` and the
 *     edits stay editable (#456).
 *  2. Local DropZone parse — when there's no handoff, the user drops a PDF here
 *     and `useAnalyzedResume` drives the parse → edit → re-grade pipeline.
 *
 * The handoff is consumed once (read + cleared on mount), so a manual reload of
 * /jd-fit falls back to the DropZone rather than re-showing a stale résumé.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzedResume } from "../hooks/useAnalyzedResume.ts";
import { useEditableParse, type EditableParse } from "../hooks/useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../lib/score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../lib/heuristics/types.ts";
import { projectScoreSections } from "../lib/heuristics/projections.ts";
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
  // Read the one-shot handoff exactly once, on mount. The guard is a REF, not
  // state: `consumeJdFitHandoff` reads AND clears sessionStorage, so it is not
  // idempotent, and StrictMode (dev) runs an effect setup→cleanup→setup within
  // one commit with no re-render between. A state guard cannot short-circuit
  // the second setup — it captures the same pre-update closure — so the second
  // read would find the key already cleared and `setHandoff(null)` would win,
  // dropping the whole handoff. A ref flips synchronously and survives it.
  const consumedRef = useRef(false);
  const [handoff, setHandoff] = useState<JdFitHandoff | null>(null);
  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    setHandoff(consumeJdFitHandoff());
  }, []);

  // The handoff résumé gets its own edit layer so edits on /jd-fit re-grade,
  // mirroring useAnalyzedResume's `edited` memo but seeded from the rehydrated
  // result rather than a fresh parse.
  const handoffEdit = useEditableParse();

  // Replay the edits the user made on `/` into THIS layer, once, when the
  // handoff lands (#456). The payload carries the PRISTINE parse, so replaying
  // is what reproduces their edited résumé here — and it stays edit STATE, so an
  // added entry is still an added entry (it keeps its Remove button) instead of
  // arriving baked into the parsed arrays. Replay is additive — `addEntry` mints
  // a fresh id per call — so running it twice would append every added entry a
  // second time. Ref guard for the same reason as the consume above.
  const { replay } = handoffEdit;
  const replayedRef = useRef(false);
  useEffect(() => {
    if (!handoff || replayedRef.current) return;
    replayedRef.current = true;
    replay(handoff.edit);
  }, [handoff, replay]);
  const handoffEdited = useMemo(() => {
    if (!handoff) return null;
    const base = handoff.result;
    const observations = handoff.score.bullets ?? [];
    const applied = applyOverrides(
      base.canonical.fields,
      base.rawText,
      base.canonical.sections,
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
      base.canonical.fieldConfidence,
      handoffEdit.achievementOverrides,
    );
    const parsed = applied.fields;
    const score = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: base.canonical.fieldConfidence,
      triggers: base.triggers,
      rawText: applied.rawText,
      // Score projection off the handoff-edited canonical model (#445).
      sections: projectScoreSections(applied),
    });
    return {
      result: { ...base, canonical: { ...base.canonical, fields: parsed } },
      score,
      parsed,
    };
  }, [
    handoff,
    handoffEdit.contactOverrides,
    handoffEdit.experienceOverrides,
    handoffEdit.bulletOverrides,
    handoffEdit.educationOverrides,
    handoffEdit.achievementOverrides,
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
      result: {
        ...state.result,
        canonical: { ...state.result.canonical, fields: edited.parsed },
      },
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

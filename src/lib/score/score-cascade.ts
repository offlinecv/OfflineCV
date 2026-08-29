// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * score-cascade.ts — the ONE recipe for grading an UNEDITED `CascadeResult`.
 *
 * `AnonymousAtsScoreInput` is a six-field object whose fields come from four
 * different places on a cascade result, and every surface that grades a fresh
 * parse has to assemble it identically or the same résumé scores differently
 * depending on which door it came through. Before #652 four call sites each
 * built it by hand — the parse-time grade (`useResumeAnalysis`), the
 * LLM-recovery re-grade (`useLlmRecovery`), the saved-library re-grade
 * (`resume-library`) and the render-hop grade (`heuristics/roundtrip-hop`) —
 * with `resume-library`'s copy carrying a comment promising it "mirrors the
 * parse-time score computation exactly", which is the shape of a claim that
 * only a shared function can actually keep.
 *
 * This is the base-parse half of the pair. {@link scoreEditedResume} in
 * `lib/edit/score-edited.ts` is the other half — an override-applied résumé is
 * graded from the EDITED section view and MUST thread `claimedBulletKeys`, and
 * the two recipes are deliberately separate functions so a caller cannot reach
 * for the base one on edited input (which is exactly the #487 defect).
 */

import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "./score.ts";
import { projectScoreSections } from "../heuristics/projections.ts";
import type { CascadeResult } from "../heuristics/types.ts";

/**
 * Grade a cascade result that carries no user edits.
 *
 * No `claimedBulletKeys`: a base parse has no override maps behind it, so the
 * pool is free to mint whatever ids it likes — the one case `score.ts`
 * documents as safe to omit it.
 */
export function scoreParsedResume(result: CascadeResult): AnonymousAtsScore {
  return computeAnonymousAtsScore({
    parsed: result.canonical.fields,
    fieldConfidence: result.canonical.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    // Score projection off the canonical model (the sole parse shape, #445).
    sections: projectScoreSections(result.canonical),
  });
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * edit-pipeline.ts — the pure steps of the parse → edit → re-grade pipeline
 * `useAnalyzedResume` drives on `/` (#652).
 *
 * The hook used to hold all four steps inline: build `applyOverrides`' base out
 * of a `CascadeResult`, fold the overrides, probe which contact-link slots the
 * scorer can actually see, and fold the edited fields back onto the base result
 * for display. Only the second of those was ever a lib function. The other
 * three were React-shaped only by accident of where they were written — they
 * take values and return values — and keeping them in the hook meant the one
 * that carries a real invariant ({@link probeScoringProfileSlots}) could only be
 * tested by rendering.
 *
 * WHAT DELIBERATELY DID NOT MOVE: the memo split itself. `useAnalyzedResume`
 * folds on EVERY override change but re-grades on only the score-affecting ones
 * (#428), and that split is what keeps the score object reference identical
 * across a non-scoring profile edit. A single `(base, snapshot) => { edited,
 * score }` pipeline function would have to re-derive the score on every
 * keystroke, so the identity would be gone even though every assertion about
 * score VALUES still passed. These are separate functions because the hook has
 * to be able to call them at different times.
 */

import {
  applyProfileOverrides,
  type EditBase,
  type LegacyLinkFields,
} from "./apply-overrides.ts";
import type { BulletObservation } from "../score/score.ts";
import type {
  CascadeResult,
  FieldConfidence,
  HeuristicParsedResume,
} from "../heuristics/types.ts";
import type { ProfileOverride } from "../../hooks/useEditableParse.ts";

/**
 * Read the frozen half of an edit fold off a cascade result — the pristine
 * parse the user's snapshot is replayed against.
 *
 * `observations` stays a parameter rather than being read off the result: it is
 * the BASE parse's `score.bullets`, which lives on the parse STATE beside the
 * result, not on the result itself. See {@link EditBase.observations}.
 */
export function editBaseFromResult(
  result: CascadeResult,
  observations: readonly BulletObservation[],
): EditBase {
  return {
    parsed: result.canonical.fields,
    rawText: result.rawText,
    sections: result.canonical.sections,
    observations,
    fieldConfidence: result.canonical.fieldConfidence,
  };
}

/**
 * The slice of a contact-link edit's effect that the SCORER can see (#428):
 * only the linkedin/github legacy slots and their confidence move Completeness
 * (see `contact-profiles.ts` — a code/social profile beyond those two, or an
 * extra that doesn't back-fill an empty slot, never reaches the scorer).
 *
 * Four primitives, not an object: the caller memoises the re-grade on these
 * individually, so a wrapper reference that changes on every profile edit would
 * defeat the entire point.
 */
export interface ScoringProfileSlots {
  linkedin_url?: string;
  github_url?: string;
  linkedinConfidence?: number;
  githubConfidence?: number;
}

/**
 * Answer "did this contact-link edit move the score?" by running the SAME
 * {@link applyProfileOverrides} step the real fold runs, over a cheap four-field
 * probe rather than the whole parsed résumé.
 *
 * Running the real step is the invariant, not an optimisation: a hand-rolled
 * "is this slot scoring?" predicate beside `applyProfileOverrides` would be free
 * to drift from it, and the drift is silent — the score simply returns a stale
 * value for the channel that drifted. If `applyProfileOverrides` is widened to
 * touch a new confidence slot (`portfolio_url`, say), widen this in lockstep.
 */
export function probeScoringProfileSlots(
  fields: LegacyLinkFields,
  profileOverrides: readonly ProfileOverride[],
): ScoringProfileSlots {
  const probe: LegacyLinkFields = {
    linkedin_url: fields.linkedin_url,
    github_url: fields.github_url,
    portfolio_url: fields.portfolio_url,
    website_url: fields.website_url,
  };
  const confEdits = applyProfileOverrides(probe, profileOverrides);
  return {
    linkedin_url: probe.linkedin_url,
    github_url: probe.github_url,
    linkedinConfidence: confEdits.find((e) => e.key === "linkedin_url")
      ?.confidence,
    githubConfidence: confEdits.find((e) => e.key === "github_url")?.confidence,
  };
}

/**
 * Fold the edited fields + confidence back onto the base result's canonical
 * model — the one `CascadeResult` the root surface hands to `Result` /
 * `ReconstructedResume`.
 *
 * `sections` (and `rawText`) stay the BASE's on purpose: display never showed
 * the edited section pool or rawText, only the edited parsed fields (#445).
 * Grading THIS value instead of the `applyOverrides` result is what manufactured
 * #487 — see `score-edited.ts`.
 */
export function foldEditedIntoResult(
  base: CascadeResult,
  fields: HeuristicParsedResume,
  fieldConfidence: FieldConfidence,
): CascadeResult {
  return {
    ...base,
    canonical: { ...base.canonical, fields, fieldConfidence },
  };
}

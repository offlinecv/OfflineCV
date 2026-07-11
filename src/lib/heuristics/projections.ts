// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * projections — pure `(CanonicalResume) => T` views that replace the direct
 * reads other subsystems used to make against `CascadeResult.parsed` /
 * `CascadeResult.sections` (#443, Stage B; `docs/canonical-resume-model.md` §2.1).
 *
 * Stage B introduces two projections:
 *   - {@link projectScoreSections} — the score projection: the section pools the
 *     anonymous scorer grades from (`AnonymousAtsScoreInput.sections`), replacing
 *     `SectionedResume.byName` read straight off the cascade result.
 *   - {@link projectDisplay} — the display projection: the parsed field core plus
 *     the user's own section headings, replacing `ReconstructedResume`'s direct
 *     `result.parsed` / `result.sections.sectionHeadings` reads.
 *
 * In Stage B these are **identity-holder** projections — they return the stored
 * cores by reference, so behaviour is byte-identical to the pre-projection
 * reads. The Stage-B byte-identical proof is the unchanged corpus goldens in
 * `heuristics/corpus.test.ts`; `projections.test.ts` here is the content /
 * re-derivation tripwire that fires when a later stage swaps a body. Their value
 * is the SEAM: Stage C+ can swap a body to re-derivation (section pools
 * recomputed from the canonical model, headings derived, etc.) without editing a
 * single call site.
 *
 * NOT yet routed through these projections (byte-identical today, but will drift
 * from the editor/scorer once Stage C+ makes a body re-derive — route them when
 * that stage lands):
 *   - `pdf/ats-resume-model.ts` reads `result.sections?.sectionHeadings` for
 *     exported-PDF headings → fold into the render+export projection (Stage C).
 *   - `hooks/useResumeAnalysisLlm.ts` reads `result.sections.byName` for
 *     disagreement gating → fold into the llm-diff projection (Stage D).
 */

import type { CanonicalResume } from "./canonical.ts";
import type { HeuristicParsedResume } from "./types.ts";
import type { SectionedResume } from "./sections.ts";
import type { SectionName } from "./sections.config.ts";

/**
 * Score projection: the section pools the anonymous scorer grades from. Feeds
 * `AnonymousAtsScoreInput.sections` (`score.ts`), which pools accomplishment
 * bullets from `accomplishmentSections` and derives the skills-exclusion set
 * from `byName.get("skills")`. Identity-holder in Stage B (returns the stored
 * `SectionedResume`); re-derivation moves here in a later stage.
 */
export function projectScoreSections(
  canonical: CanonicalResume,
): SectionedResume {
  return canonical.sections;
}

/**
 * The display-projection surface `ReconstructedResume` reads: the parsed field
 * core, plus the user's verbatim section headings (#285) so the editor renders
 * the resume's own wording instead of the canonical section word.
 */
export interface DisplayProjection {
  /** Field core the reconstructed-resume rows render. */
  readonly parsed: HeuristicParsedResume;
  /** Section name → verbatim heading text, when present. */
  readonly sectionHeadings?: ReadonlyMap<SectionName, string>;
}

/**
 * Display projection: the parsed fields + section headings the reconstructed
 * resume renders. Identity-holder in Stage B (both members returned by
 * reference off the canonical cores).
 */
export function projectDisplay(canonical: CanonicalResume): DisplayProjection {
  return {
    parsed: canonical.fields,
    sectionHeadings: canonical.sections.sectionHeadings,
  };
}

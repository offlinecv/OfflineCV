// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 * Routed through {@link projectDisplay} as of Stage C (#444):
 *   - `pdf/ats-resume-model.ts` — `buildAtsResumeModel` reads the field core and
 *     `sectionHeadings` for the exported PDF through {@link projectDisplay} (the
 *     render+export projection), not straight off `result.parsed` /
 *     `result.sections`.
 *
 * Stage D+E (#445) adds {@link projectLlmDiff} — the llm-diff projection that
 * coerces on-device `LlmParsedResume` output into a `CanonicalResume`-shaped
 * value so `diffParses` reads two canonical shapes. The disagreement-gating
 * `result.sections.byName` read that used to live in `useResumeAnalysisLlm`
 * is now derived inside `diffParses` off the heuristic canonical's sections.
 */

import type { CanonicalResume } from "./canonical.ts";
import { toCanonicalResume } from "./canonical.ts";
import type { HeuristicParsedResume } from "./types.ts";
import type { SectionedResume } from "./sections.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./sections.ts";
import type { SectionName } from "./sections.config.ts";
import type { LlmParsedResume } from "../webllm/parse-resume.ts";

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

/**
 * llm-diff projection: coerce an on-device {@link LlmParsedResume} into a
 * {@link CanonicalResume}-shaped value so the disagreement detector can diff two
 * canonical shapes (`diffParses`) instead of hand-syncing a parallel
 * `LlmParsedResume` type against `HeuristicParsedResume` (the retired
 * `parse-resume.ts` "Keep field names in sync" note, #445).
 *
 * This is a field-name-mapping adapter only — no re-parsing, no section
 * splitting (the LLM output has no section pools). The section-membership core
 * and `fieldConfidence` are intentionally EMPTY/best-effort: `diffParses`
 * derives its whole-section-drop gate from the *heuristic* canonical's sections
 * (the sectioner is the ground truth on headers), never from the LLM side, and
 * reads no confidence off the LLM parse. `null` scalars map to `undefined`
 * (both read as "absent" by the diff's `presentScalar`).
 */
export function projectLlmDiff(llm: LlmParsedResume): CanonicalResume {
  const fields: HeuristicParsedResume = {
    full_name: llm.full_name ?? undefined,
    email: llm.email ?? undefined,
    phone: llm.phone ?? undefined,
    location: llm.location ?? undefined,
    summary: llm.summary ?? undefined,
    skills: llm.skills,
    experience: llm.experience.map((e) => ({
      title: e.title,
      company: e.company,
      description: e.description,
    })),
    education: llm.education.map((e) => ({
      degree: e.degree,
      institution: e.institution,
    })),
  };
  const sections: SectionedResume = {
    byName: new Map(),
    accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
    source: "regex",
  };
  return toCanonicalResume(fields, sections, {});
}

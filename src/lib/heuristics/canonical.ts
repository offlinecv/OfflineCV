// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * canonical — the single internal résumé representation the migration collapses
 * the five parallel shapes toward (#443, Stage B of the canonical-résumé-model
 * plan; design in `docs/canonical-resume-model.md` §2).
 *
 * `CanonicalResume` composes the two cores that already exist:
 *   - the **field core** — `HeuristicParsedResume` (contact / summary / skills /
 *     experience / education …), what the parser produces;
 *   - the **section-membership core** — `SectionedResume` (`byName` pools +
 *     headings + provenance), what the scorer and editor grade from.
 *
 * In Stage B it is deliberately a thin, by-reference composition — no field is
 * copied or re-derived, so `runCascade` can build it and hand its two members
 * straight back out as the `CascadeResult` compatibility façade with zero
 * behavioural change. Every downstream shape (display / score / render+export /
 * JSON-Resume / llm-diff) becomes a pure projection off this model (see
 * `projections.ts`); later stages move re-derivation and the round-trip
 * invariant onto it (§3, Stage C+), swapping projection bodies without touching
 * the call sites established here.
 */

import type { HeuristicParsedResume, FieldConfidence } from "./types.ts";
import type { SectionedResume } from "./sections.ts";

/**
 * Persisted parser-shape version — bumped whenever the shape of a cached parse
 * record (the `CanonicalResume`/`CascadeResult` structure the #321 resume-library
 * writes to IndexedDB) changes in a way that a straight structured-clone
 * deserialize would misread. `"2"` marks the Stage D+E cutover (#445): the
 * pre-cutover records carried a top-level `parsed`/`sections`/`fieldConfidence`
 * façade with no `canonical` member, so they must NOT be deserialized as a
 * canonical record — a version mismatch forces a re-parse from the stored PDF
 * blob. Paired with `ATS_SCORE_ALGO_VERSION` in the cache key (`resume-library.ts`).
 */
export const CANONICAL_SHAPE_VERSION = "2" as const;

/**
 * The canonical internal résumé: a field core + a section-membership core +
 * per-field confidence, held by reference. The single source of truth the
 * projections read from — and, as of the Stage D+E cutover (#445), the sole
 * parse shape (the `CascadeResult` compatibility façade that used to duplicate
 * these members is gone; `CascadeResult.canonical` now holds this model).
 */
export interface CanonicalResume {
  /** Parsed field core — contact, summary, skills, experience, education. */
  readonly fields: HeuristicParsedResume;
  /** Section-membership core — `byName` pools, headings, splitter provenance. */
  readonly sections: SectionedResume;
  /** Per-field parse confidence (0..1). Orthogonal parse-provenance metadata the
   *  cascade genuinely emits (confidence-per-field, not a second copy of the
   *  field *values*), so it is a member of the canonical model rather than a
   *  projection argument threaded at every call site (#445, Stage D+E). The
   *  scorer and contact-gap display both gate contact fields by this. */
  readonly fieldConfidence: FieldConfidence;
}

/**
 * Compose a {@link CanonicalResume} from its three cores. PURE and allocation-
 * light: every member is carried by reference (they are read-only downstream),
 * so this is a zero-cost view, not a copy. `runCascade` calls this as it
 * assembles each result.
 */
export function toCanonicalResume(
  fields: HeuristicParsedResume,
  sections: SectionedResume,
  fieldConfidence: FieldConfidence,
): CanonicalResume {
  return { fields, sections, fieldConfidence };
}

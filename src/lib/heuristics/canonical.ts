// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

import type { HeuristicParsedResume, CascadeResult } from "./types.ts";
import type { SectionedResume } from "./sections.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./sections.ts";

/** Inert section core for a façade that carries none — e.g. a hand-built test
 *  fixture predating the `sections` field, or a pre-#132 cached record. Yields
 *  `byName.get(...) === undefined` and no headings, exactly the fall-through the
 *  old `result.sections?.…` reads gave. Production cascade always sets a real
 *  section core, so this only backstops the loose-fixture boundary.
 *
 *  Frozen so a shared singleton can't be mutated into cross-contamination.
 *  `Object.freeze` does NOT lock the inner `Map` — but nothing writes to a
 *  section core in place (`apply-overrides` clones `byName` before editing), so
 *  the empty map stays empty; a future in-place writer must clone first. */
const EMPTY_SECTION_CORE: SectionedResume = Object.freeze({
  byName: new Map(),
  accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
  source: "regex",
});

/**
 * The canonical internal résumé: a field core + a section-membership core,
 * held by reference. The single source of truth the projections read from.
 */
export interface CanonicalResume {
  /** Parsed field core — contact, summary, skills, experience, education. */
  readonly fields: HeuristicParsedResume;
  /** Section-membership core — `byName` pools, headings, splitter provenance. */
  readonly sections: SectionedResume;
}

/**
 * Compose a {@link CanonicalResume} from its two cores. PURE and allocation-
 * light: both members are carried by reference (they are read-only downstream),
 * so this is a zero-cost view, not a copy. `runCascade` calls this as it
 * assembles each result.
 */
export function toCanonicalResume(
  fields: HeuristicParsedResume,
  sections: SectionedResume,
): CanonicalResume {
  return { fields, sections };
}

/**
 * Adapter for read-site consumers that still receive the {@link CascadeResult}
 * compatibility façade: lift its `parsed` + `sections` back into the canonical
 * view so display / score projections read one shape. The inverse of how
 * `runCascade` derives the façade from the canonical model. PURE.
 *
 * `sections` is required on a production `CascadeResult`, but hand-built test
 * fixtures (and pre-#132 records) can omit it — the old read sites guarded with
 * `result.sections?.…`, so we mirror that here by substituting an inert section
 * core rather than propagating `undefined` into the non-null canonical model.
 */
export function canonicalFromCascade(
  result: Omit<CascadeResult, "sections"> & { sections?: SectionedResume },
): CanonicalResume {
  return { fields: result.parsed, sections: result.sections ?? EMPTY_SECTION_CORE };
}

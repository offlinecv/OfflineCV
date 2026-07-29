// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * score-edited.ts — the ONE recipe for grading an override-applied résumé.
 *
 * The anonymous scorer pools its bullet set from `sections` (#133), so a résumé
 * with edits in it has to be graded off the EDITED section view — the one
 * `applyOverrides` returns — or the pool carries pre-edit text while the entry
 * descriptions carry post-edit text. That desync is not cosmetic: the exporter
 * attributes pooled bullets to entries by matching normalised TEXT
 * (`groupBulletsByExperience`), so an edited bullet whose pool line still reads
 * the old text matches no description, groups under "Other", and is dropped from
 * the entry — the edit AND the text it replaced both vanish from the downloaded
 * PDF.
 *
 * That is exactly what #487 was: `corpus-edit-roundtrip.test.ts` scored its
 * `display` (edited FIELDS, BASE sections — the shape `useAnalyzedResume` builds
 * for DISPLAY, where sections are deliberately the base's, #445) and so baselined
 * 39 fixtures as "bullet overrides don't survive the round-trip". Production
 * never had that bug; it scores this way. The gate had reimplemented the recipe
 * and got it wrong, and nothing tied the two together — so the recipe lives here
 * now and both call it.
 */

import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
} from "../score/score.ts";
import { projectScoreSections } from "../heuristics/projections.ts";
import type { LayoutTrigger } from "../heuristics/types.ts";
import type { ApplyOverridesResult } from "./apply-overrides.ts";

/**
 * Re-grade an `applyOverrides` result. `triggers` come from the BASE parse —
 * they describe the uploaded PDF's layout, which no edit can change.
 *
 * `claimedBulletKeys` is REQUIRED, not optional, and that is the point: it is
 * every key the two bullet maps whose edits `edited` already carries are filed
 * under, and without it the re-graded pool re-mints ids those instructions are
 * already using — which is how an edit to one of two identical bullets
 * destroyed the other, how the second of two identical bullets could not be
 * removed, and how re-editing a bullet back to an earlier text diverged the
 * display from the export (#648, `bullet-id.ts`). Making it required means a new
 * edited-grade caller has to think about it rather than inherit the defect from
 * a default.
 *
 * Pass `[...Object.keys(bulletOverrides), ...removedBullets]` — the same two
 * maps handed to `applyOverrides`.
 */
export function scoreEditedResume(
  edited: ApplyOverridesResult,
  triggers: LayoutTrigger[],
  claimedBulletKeys: Iterable<string>,
): AnonymousAtsScore {
  return computeAnonymousAtsScore({
    parsed: edited.fields,
    fieldConfidence: edited.fieldConfidence,
    triggers,
    rawText: edited.rawText,
    sections: projectScoreSections(edited),
    claimedBulletKeys,
  });
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeTargeting — the derivation seam in front of `TargetingSection` (#955).
 *
 * `TargetingSection` takes eight props, and every one of them is derived from
 * the same three values (`result`, `score`, `edit`) by the same four helper
 * calls. #955 moved that section out of `ReconstructedResume` and into the
 * score card, and the two lanes that render a résumé do not share a parent:
 * `/`'s parse lane goes `App` → `Result`/`ParsedCard`, while the from-scratch
 * authoring lane (`App`, `state.phase === "authoring"`) renders
 * `ReconstructedResume` directly with no `Result` and no score card at all. So
 * the section needs two mount points, and this module exists so that the
 * derivations behind it have ONE definition — the alternative is two copies of
 * `contactCompleteness(applyContactOverrides(buildContactFields(…)))` drifting
 * apart, which is the exact failure `ContactCard`'s docblock already warns
 * about for the same helper chain.
 *
 * THE ONE-INSTANCE INVARIANT STILL HOLDS, and it has to be stated here because
 * a reader counting call sites will find two. `useSkillsReorder` is shared
 * apply/undo state, so two mounted `SkillsOrderFindingRow`s would both enter
 * the confirmation strip on a single Apply (see `SkillTermGuidance`'s
 * docblock). The two call sites are `Result` and `App`'s authoring branch, and
 * they are MUTUALLY EXCLUSIVE `state.phase` arms — `done` renders one,
 * `authoring` the other, never both — so exactly one instance is ever mounted.
 * A third mount, or a mount inside a surface both lanes share, would break it.
 *
 * Derivation-only: it owns no chrome, no tokens and no layout. Whatever it is
 * dropped into supplies those — in both lanes that is now `ScoreDetails`'
 * details region, which docks the section away with the score readout and
 * keeps it MOUNTED while docked, so `useSkillsReorder`'s apply/undo state
 * survives the countdown. `TargetingSection` self-hides when it has nothing to
 * say, so this renders nothing on a résumé with no findings.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import {
  applyContactOverrides,
  buildContactFields,
  contactCompleteness,
} from "../../lib/contact.ts";
import { projectDisplay } from "../../lib/heuristics/projections.ts";
import { deriveTitles } from "../../lib/job-search/query-builder.ts";
import { useSkillsReorder } from "../../hooks/useSkillsReorder.ts";
import { TargetingSection } from "./TargetingSection.tsx";

interface ResumeTargetingProps {
  /** The edit-folded parse the surrounding lane renders — `activeResult` on
   *  `/`, `displayResult` in the authoring lane. */
  result: CascadeResult;
  /** The score graded from that same parse; only `bullets` is read. */
  score: AnonymousAtsScore;
  /** Lifted edit state (#82) — the write path for every control below. */
  edit: EditableParse;
}

export function ResumeTargeting({ result, score, edit }: ResumeTargetingProps) {
  // The same four derivations `ReconstructedResume` ran before #955, by the
  // same helpers. None is memoized, because none of them was memoized there
  // either: `deriveTitles` and `projectDisplay` both mint a fresh value every
  // render on both sides of the move (`projectDisplay` is an identity-holder —
  // a two-field object literal over already-stored references, see
  // `projections.ts`), so a memo here would be a behaviour change dressed up
  // as a relocation.
  const titles = deriveTitles(result.canonical.fields);
  const contactMissing = contactCompleteness(
    applyContactOverrides(
      buildContactFields(result.canonical),
      edit.contactOverrides,
    ),
  ).missing;

  // Skills-ordering coaching (#544). See the module docblock for why one
  // instance survives two call sites.
  const skillsOrder = useSkillsReorder(
    result.canonical.fields.skills,
    result.canonical.fields.skillCategories,
    titles,
    edit.reorderSkills,
  );

  return (
    <TargetingSection
      titles={titles}
      primary={edit.contactOverrides.headline ?? result.canonical.fields.headline}
      onPrimaryChange={(value) => edit.setContactField("headline", value)}
      // Term-quality guidance (#586): same classifier as `/jobs/`'s
      // `TermQualityAdvisory`, résumé-framed copy, writes only through the
      // existing `addSkill` inline-edit path.
      parsed={projectDisplay(result.canonical).parsed}
      onAddSkill={edit.addSkill}
      // Skills-ordering coaching (#544) rides the same panel: it is scored
      // against `titles[0]` exactly as the term guidance is, and unlike the
      // critique lane this surface is not behind a WebGPU model download.
      skillsOrder={skillsOrder}
      bullets={score.bullets ?? []}
      contactMissing={contactMissing}
    />
  );
}

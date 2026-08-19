// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SkillTermGuidance — surfaces the term-quality classifier's verdict on the
 * résumé's OWN skills, in the résumé review lane (#586). `TermQualityAdvisory`
 * (#585) does the equivalent job on `/jobs/`, but that surface can only edit
 * the search *query* — it has no DropZone and no editor. This one lives on `/`,
 * where `onAddSkill` writes through the existing inline-edit path
 * (`useEditableParse`), so a suggestion here can actually land in the document.
 *
 * PLACEMENT: directly under `RolesPanel`, above Experience (#605 review). It
 * used to render last, below `SkillsSection`. Two reasons it moved up:
 *
 *  1. Its content is a FUNCTION of the starred role. `buildJobQuery` →
 *     `deriveTitles` puts the promoted headline at `titles[0]`, and
 *     `assessQueryTerms` resolves the role profile from it. Star a different
 *     title and this whole list changes. Cause and effect have to be adjacent
 *     or the dependency is invisible; four résumé sections apart, it read as a
 *     static footer.
 *  2. It is advice about the document, not part of the document. Sitting last
 *     among the résumé sections framed it as one.
 *
 * The cost of moving is that its `onAddSkill` target — `SkillsSection` — is now
 * off-screen, so the general "put feedback next to the thing it affects" rule
 * is being paid for rather than followed. It is paid with a confirm-in-place
 * trail plus an `aria-live` announcement (there is no toast primitive in this
 * design system), so an add still reports where it landed.
 *
 * SAME CLASSIFIER, NO SECOND JUDGEMENT. Builds a `JobQuery` from the current
 * parse with `buildJobQuery` and reads it through `assessQueryTerms` — the
 * same function `/jobs/` calls. This component adds no rule of its own; it
 * only decides what to show and how to phrase the surrounding copy.
 *
 * COPY IS DELIBERATELY NOT `/jobs/`'S COPY. `TermQualityAdvisory` frames
 * everything as "your query" (heading: "Commonly expected for this role, not
 * in your query") because that surface edits a search. Here the framing is
 * always "your résumé" / "in your résumé" — the document, not a query — per
 * the issue's instruction that an identically-reading sentence belongs on
 * only one surface. `TermVerdict.reason` is the one exception: it is
 * written once in `term-quality.ts` and rendered verbatim on both surfaces on
 * purpose, so the same skill can never be explained two different ways.
 *
 * "NOISE" SKILLS ARE DELIBERATELY OMITTED. A "noise" verdict's reason talks
 * about search admission ("Too common as a search term to narrow your
 * results") — a query concept with nothing to say about a résumé. Only
 * "strong" (recognized) and "weak" (not recognized by matchers, but not
 * struck as worthless — term-quality.ts's central rule) skill verdicts, plus
 * `missing` skills, render here. Both are `[]`/absent whenever no role
 * resolved (term-quality.ts rule 1), which is what makes this component
 * return `null` for an unresolvable résumé too — no separate check is needed
 * for that case.
 *
 * NEVER AUTO-EDITS. `onAddSkill` fires only from a user click on an `AddPill`
 * (the same primitive `TermQualityAdvisory` reuses) — this component reads
 * the parse, it never writes to it on its own.
 *
 * Reuse Gate (PR body): no existing résumé-review surface fit. `CritiquePanel`
 * is WebLLM-gated content critique (prose/bullet quality), not vocabulary
 * matching, and lives in a different tab entirely. The skills-ordering
 * critique issue (#544) is unimplemented — there is no surface to extend.
 * `TermQualityAdvisory` itself can't be reused as-is: it writes into a
 * `JobQuery`, not the résumé model, and its copy is query-framed throughout.
 * So this is a new, narrowly-scoped sibling, not a parallel copy of either.
 *
 * SKILLS ORDERING (#544) IS HOSTED HERE, and this is now the ONLY place it
 * renders. It first shipped inside `CritiqueResults`, which only mounts under
 * `status.kind === "done"` — i.e. after the visitor opts into the on-device
 * model download and runs it. A HEURISTIC finding that needs WebGPU to be seen
 * is not a heuristic finding in any way the user can tell, and most visitors
 * never run the model, so the issue's "a buried high-signal skill triggers a
 * call-out" was unmet on the majority path. This panel is the surface the
 * paragraph above says did not exist yet: same lane, no model gate, keyed off
 * the same `titles[0]` the ordering heuristic scores against, and its Apply
 * writes through the same `useEditableParse` seam `onAddSkill` does. It is
 * mounted here and nowhere else, so the LLM-running and LLM-absent paths
 * cannot show the row twice — the controller is shared state, so two mounted
 * rows would both enter the confirmation strip on a single Apply.
 */

import { useState } from "react";
import { Card } from "@design-system";
import { assessQueryTerms } from "../../lib/job-search/term-quality.ts";
import { buildJobQuery, type ResumeQueryInput } from "../../lib/job-search/query-builder.ts";
import { missingTermLabel } from "./TermQualityAdvisory.tsx";
import { AddPill } from "./ReconstructedAdd.tsx";
import { SkillsOrderFindingRow } from "./SkillsOrderFinding.tsx";
import type { SkillsReorderController } from "../../hooks/useSkillsReorder.ts";

/**
 * Read the parse through the term-quality classifier: what it recognized, what
 * it could not match, and what the resolved role expects that is absent.
 *
 * Exported because `TargetingSection` needs the count of open suggestions for
 * its collapsed summary (#825), and a second `buildJobQuery` +
 * `assessQueryTerms` call over there would be a second definition of "what
 * counts as a suggestion" — one refactor away from the badge and the panel
 * disagreeing about how many there are. Return type is inferred on purpose: the
 * verdict objects carry `reason`, and the missing terms carry what
 * `missingTermLabel` reads, so narrowing them to a hand-written interface here
 * would only mean widening it again the next time either is rendered.
 *
 * Pure and cheap; both callers run it per render, as this component always has.
 */
export function assessResumeSkills(parsed: ResumeQueryInput) {
  const assessment = assessQueryTerms(buildJobQuery(parsed));
  const skillVerdicts = assessment.verdicts.filter((v) => v.kind === "skill");
  return {
    /** Recognized — nothing to do, rendered as reassurance. */
    recognized: skillVerdicts.filter((v) => v.quality === "strong"),
    /** Not matched to a known skill. NOT struck as worthless (see
     *  `term-quality.ts`'s central rule) — explained, never removed. */
    unrecognized: skillVerdicts.filter((v) => v.quality === "weak"),
    /** The one ACTIONABLE half, and therefore the only half worth counting. */
    missing: assessment.missing.filter((m) => m.kind === "skill"),
  };
}

export function SkillTermGuidance({
  parsed,
  onAddSkill,
  skillsOrder,
}: {
  /** The current parse — same shape `FindJobsPanel` feeds `buildJobQuery`. */
  parsed: ResumeQueryInput;
  /** The existing inline-edit path (`useEditableParse.addSkill`) — the ONLY
   *  way a suggestion here reaches the résumé. */
  onAddSkill: (skill: string) => void;
  /** The skills-ordering coaching controller (#544, `useSkillsReorder`) — a
   *  second HEURISTIC finding about the same Skills section, hosted here (see
   *  the module docblock). Optional: a caller that omits it, or a résumé with
   *  nothing to flag, gets byte-identical pre-#544 output. */
  skillsOrder?: SkillsReorderController;
}) {
  // Terms added from this panel, in click order. Purely a confirmation trail:
  // the résumé itself is written by `onAddSkill`, and an added term leaves
  // `missing` on the next assessment anyway — so the pill vanishing is the state
  // change, and this is the acknowledgement that the vanish alone can't give.
  const [added, setAdded] = useState<string[]>([]);

  const { recognized, unrecognized, missing: missingSkills } =
    assessResumeSkills(parsed);

  // `applied` keeps the block up while the confirmation strip serves out its
  // own hold, after the underlying finding has already recomputed away.
  const showSkillsOrder =
    skillsOrder !== undefined &&
    (skillsOrder.finding !== undefined || skillsOrder.applied);

  // The ordering finding is an INDEPENDENT reason to render: it needs only
  // title tokens, whereas all three buckets above empty out whenever
  // `term-quality.ts` cannot resolve a role PROFILE from the same titles
  // (its rule 1). A résumé that hits one and not the other is ordinary, and
  // self-hiding on the buckets alone would drop the ordering call-out on it.
  if (
    recognized.length === 0 &&
    unrecognized.length === 0 &&
    missingSkills.length === 0 &&
    !showSkillsOrder
  ) {
    return null;
  }

  const add = (label: string) => {
    onAddSkill(label);
    setAdded((prev) => (prev.includes(label) ? prev : [...prev, label]));
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-content-primary">
          Skills this role usually asks for
        </h2>
        <p className="max-w-prose text-sm text-content-tertiary">
          Based on the first role title above. Star a different one and this
          list changes with it.
        </p>
      </div>

      {missingSkills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-content-secondary">
            Not in your résumé yet — add the ones you actually have:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {missingSkills.map((term) => (
              <AddPill
                key={term.term}
                label={missingTermLabel(term)}
                onClick={() => add(missingTermLabel(term))}
              />
            ))}
          </div>
        </div>
      )}

      {/* Confirm in place — there is no toast primitive here, and this panel now
       *  sits far above the Skills section it writes into, so an add would
       *  otherwise have no visible destination. `aria-live` announces it once;
       *  the text carries the meaning, never colour alone. */}
      <p aria-live="polite" className="sr-only">
        {added.length > 0
          ? `Added to your skills: ${added.join(", ")}.`
          : ""}
      </p>
      {added.length > 0 && (
        <p className="text-sm text-content-tertiary">
          <span className="font-medium text-feedback-success-text">Added</span>{" "}
          to your Skills section: {added.join(", ")}.
        </p>
      )}

      {/* Between the skills you don't have and the ones you do — the ordering
       *  finding is about skills already IN the résumé, so it belongs on this
       *  side of that boundary. `<ul>` because the row is an `<li>`, shared
       *  verbatim with the finding-row visual language it was written for. */}
      {showSkillsOrder && skillsOrder && (
        <ul className="flex flex-col gap-2 list-none">
          <SkillsOrderFindingRow skillsOrder={skillsOrder} />
        </ul>
      )}

      {recognized.length > 0 && (
        <p className="text-sm text-content-tertiary">
          <span className="font-medium text-content-secondary">
            Already in your résumé:
          </span>{" "}
          {recognized.map((v) => v.term).join(", ")}
        </p>
      )}

      {unrecognized.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-content-tertiary">
            <span className="font-medium text-content-secondary">
              We could not match these to a known skill:
            </span>{" "}
            {unrecognized.map((v) => v.term).join(", ")}
          </p>
          {/* `reason` rendered verbatim, per term-quality.ts's contract — the
           *  same explanation `/jobs/` would show for the same skill. */}
          <ul className="flex flex-col gap-0.5 pl-4 text-sm text-content-tertiary">
            {unrecognized.map((v) => (
              <li key={v.term} className="list-disc">
                <span className="font-medium">{v.term}</span> — {v.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

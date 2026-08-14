// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TargetingSection — the two advice panels that sit between the contact block
 * and the résumé document, folded into one collapsed disclosure (#825).
 *
 * `RolesPanel` ("Which role are you targeting?") and `SkillTermGuidance`
 * ("Skills this role usually asks for") are the most useful things on the page
 * and were also the most expensive: two full `Card`s, several hundred pixels
 * tall between them, standing directly above the résumé the user came to read.
 * A visitor who dropped a PDF to see what a parser read back had to scroll past
 * two blocks of advice to reach the answer.
 *
 * Collapsing them is not hiding them. The summary row states what is behind it,
 * carries a `count` badge of the skills that are actually ADDABLE, and takes
 * `Disclosure`'s `warn` mark when no role has been picked — so the two things
 * the panels want to tell the user (there are N suggestions / nothing prints
 * under your name yet) are legible without opening anything. What is spent is a
 * click to act on them; what is bought is the résumé being visible from the top
 * of the section.
 *
 * WHY THE PAIR MOVES AS A PAIR, AND WHY IT STAYS PUT. `RolesPanel`'s docblock
 * makes the adjacency load-bearing: the skill suggestions are a function of the
 * starred title (`buildJobQuery` → `deriveTitles` → `titles[0]`), so star a
 * different title and the list below changes. That is only legible while the
 * two are next to each other, which is why this wraps both rather than
 * collapsing one, and why the section stays where the pair already was —
 * between the contact card and the summary — rather than being relegated
 * below the document. The decision zone documented in `ReconstructedResume`
 * (what needs fixing → who you are → what you're aiming at → what that target
 * expects) is unchanged in order; only its fourth and third beats are folded.
 *
 * Reuse analysis (CLAUDE.md's Reuse Gate). This is not a new workflow surface:
 * it renders no control of its own, owns no state, and adds no rule. It is the
 * shared `Disclosure` (#823) wrapped around two existing feature components,
 * with the summary metadata computed from the classifier those components
 * already call — `assessResumeSkills`, exported from `SkillTermGuidance` for
 * this one purpose, so the badge and the panel cannot disagree about the count.
 * No raw `<details>`, no second count pill (`Disclosure` owns `CountBadge`), no
 * hardcoded palette.
 */

import { Disclosure } from "@design-system";
import { RolesPanel } from "./RolesPanel.tsx";
import {
  SkillTermGuidance,
  assessResumeSkills,
} from "./SkillTermGuidance.tsx";
import type { ResumeQueryInput } from "../../lib/job-search/query-builder.ts";

interface TargetingSectionProps {
  /** Distinct role titles, most-recent-first, from `deriveTitles`. */
  titles: string[];
  /** The currently chosen primary — the `headline` override, or undefined. */
  primary?: string;
  /** Commit a new primary (or "" to clear back to the parser's default). */
  onPrimaryChange: (value: string) => void;
  /** The current parse — same shape `FindJobsPanel` feeds `buildJobQuery`. */
  parsed: ResumeQueryInput;
  /** `useEditableParse.addSkill` — the only way a suggestion reaches the résumé. */
  onAddSkill: (skill: string) => void;
}

export function TargetingSection({
  titles,
  primary,
  onPrimaryChange,
  parsed,
  onAddSkill,
}: TargetingSectionProps) {
  const skills = assessResumeSkills(parsed);

  // Both children self-hide, so the wrapper has to as well or a résumé with no
  // parsed titles gets a disclosure that opens onto nothing. `RolesPanel`
  // renders only with titles; `SkillTermGuidance` renders only with something
  // in one of the three buckets — and with no titles there is no role to
  // resolve, so `term-quality.ts`'s rule 1 empties all three anyway. Both are
  // still checked rather than one inferred from the other: the inference is a
  // property of a module this file does not own.
  const hasSkillGuidance =
    skills.recognized.length > 0 ||
    skills.unrecognized.length > 0 ||
    skills.missing.length > 0;
  if (titles.length === 0 && !hasSkillGuidance) return null;

  // The count is the ADDABLE half only. Counting the recognized skills too
  // would put a badge of 12 on a résumé with nothing to do, which is the same
  // class of unearned claim #826 removed from the journey rail's ✓.
  const suggestions = skills.missing.length;

  // The warn mark means "no role prints under your name", which is
  // `RolesPanel`'s own no-pick state — a real consequence on the exported PDF
  // (`render-ats-pdf.ts` guards on `model.contact.headline`), not a nag. Read
  // off the same `primary` value that panel resolves, and deliberately not off
  // whether it MATCHES a chip: a user-typed headline prints perfectly well
  // without being one of the titles.
  const noRolePicked = !primary || primary.trim() === "";

  return (
    <Disclosure
      summary="Targeting — your role and its expected skills"
      count={suggestions}
      warn={noRolePicked}
      warnLabel="no role picked, so none prints on your PDF"
    >
      <div className="flex flex-col gap-6">
        <RolesPanel
          titles={titles}
          primary={primary}
          onPrimaryChange={onPrimaryChange}
        />
        <SkillTermGuidance parsed={parsed} onAddSkill={onAddSkill} />
      </div>
    </Disclosure>
  );
}

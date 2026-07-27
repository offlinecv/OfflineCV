// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobQueryEditor — the editable search query of the job-search workbench,
 * emitted as the four panels of `FindJobsPanel`'s `Stepper` (#602).
 *
 * WHAT CHANGED IN #602 AND WHY. This used to be a three-column grid that put
 * every field on screen at once: ~40 chips at one visual weight, a 12-rung
 * level rail, a mark legend, the whole-query advisory and (via the panel) the
 * outbound contract and the external-board links. Everything was reachable and
 * nothing was findable — and the contract card, which the form exists to lead
 * up to, rendered LAST, about a thousand pixels below the chips it describes.
 * The fields are now grouped into an ordered walk whose reading order is the
 * order of the work:
 *
 *   1. **Role** — the titles, one of which is what actually leaves the browser.
 *   2. **Skills** — the second egressing term, and the fit evidence.
 *   3. **Narrow** — the narrowing axes: where, what to drop, a pay floor, and
 *      which company boards to check.
 *   4. **Review** — the pre-flight contract (`SearchPlanCard`), the whole-query
 *      findings, and the external deep links, immediately above the button they
 *      describe.
 *
 * The per-kind suggestions and the mark legend moved to sit under the chip rows
 * they belong to; a key to marks a screen away was decoration.
 *
 * This component does NOT own the `Stepper` — `FindJobsPanel` does, because the
 * rail's summaries need the selected-company count and the terminal action is
 * that panel's Search button. `StepPanel` reads its position from context, so
 * emitting the panels from here costs no wiring. Panels stay mounted when
 * inactive (see `Stepper`), so a half-typed chip draft survives stepping away.
 *
 * Controlled by the parent through `query` / `onChange` — the query is the
 * workbench's single source of truth (the fit ranking and the #568 live re-rank
 * both read it), so it cannot live here. Every mutation is a whole-query
 * replacement, which keeps the "one Search click = one fetch" invariant in
 * `useJobSearch` unaffected by editing.
 *
 * The query is scratch state seeded from the parse; it intentionally does NOT
 * write back into the résumé override model — editing a search is not editing
 * the résumé.
 */

import { useState } from "react";
import { EditableField, StepPanel } from "@design-system";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";
import { ROLE_HINT } from "../../lib/job-search/query-steps.ts";
import {
  canonicalSkillLabels,
  parseSeniorityLabel,
} from "../../lib/job-search/query-builder.ts";
import { promoteSkill, promoteTitle } from "../../lib/job-search/search-plan.ts";
import type { RoleFamily } from "../../lib/job-search/role-keywords.ts";
import { assessQueryTerms, type MissingTerm } from "../../lib/job-search/term-quality.ts";
import type { JobBoardLink } from "../../lib/job-search/deep-links.ts";
import type { CompanyTargets as CompanyTargetsState } from "../../hooks/useCompanyTargets.ts";
import { ChipListEditor } from "./ChipListEditor.tsx";
import { CompanyTargets } from "./CompanyTargets.tsx";
import { CompFloorInput } from "./CompFloorInput.tsx";
import { ExternalBoardLinks } from "./ExternalBoardLinks.tsx";
import { RoleFamilyChips } from "./RoleFamilyChips.tsx";
import { LevelSelect } from "./LevelSelect.tsx";
import { AddPill } from "./ReconstructedAdd.tsx";
import { QueryStepSection } from "./QueryStepSection.tsx";
import { SearchPlanCard } from "./SearchPlanCard.tsx";
import { TermGlyphLegend } from "./TermGlyphLegend.tsx";
import { missingTermLabel, TermQualityAdvisory } from "./TermQualityAdvisory.tsx";

/**
 * The title that produced `query.seniority`, or `undefined` when the level
 * was set by the user rather than derived. Mirrors `deriveSeniorityAcrossTitles`'
 * scan order (`query.titles` is already most-recent-first) using the exported
 * `parseSeniorityLabel` — no second taxonomy, no new state on `JobQuery` (#581).
 */
function seniorityProvenance(query: JobQuery): string | undefined {
  if (!query.seniority) return undefined;
  return query.titles.find(
    (title) => parseSeniorityLabel(title) === query.seniority,
  );
}

export function JobQueryEditor({
  query,
  onChange,
  isDegenerate,
  links,
  companyTargets,
}: {
  query: JobQuery;
  onChange: (next: (q: JobQuery) => JobQuery) => void;
  /** True when the parse yielded neither a title nor a skill — the search
   *  cannot run, and the hint below tells the user what to type. */
  isDegenerate: boolean;
  /** Deep links for the Review step, built by the parent from the same query. */
  links: readonly JobBoardLink[];
  /** The company-board picker's state, rendered in the Narrow step (#602). */
  companyTargets: CompanyTargetsState;
}) {
  // Progressive disclosure for Seniority (#540): a résumé whose titles carry
  // no recognized seniority keyword renders no inert placeholder field — the
  // row appears only once a seniority was derived, or the user opts in via
  // the "+ Target level" pill. Purely presentational, so it stays local here.
  const [seniorityExpanded, setSeniorityExpanded] = useState(false);

  // ChipListEditor already trims + case-insensitively dedups before calling
  // onAdd, so these handlers just append / filter the controlled list.
  const addTitle = (title: string) =>
    onChange((q) => ({ ...q, titles: [...q.titles, title] }));
  const removeTitle = (title: string) =>
    onChange((q) => ({ ...q, titles: q.titles.filter((t) => t !== title) }));

  // Skills carry a second, derived field: `canonicalSkills`, the subset the
  // shared dictionary recognizes, which is what gives `assessQueryTerms` standing
  // to call a skill weak. Recomputed from the whole list on every edit through
  // the same `canonicalSkillLabels` `buildJobQuery` used, so a chip the user
  // types is annotated exactly like a derived one and the annotation can never
  // describe only the original parse.
  const withSkills = (q: JobQuery, skills: string[]): JobQuery => ({
    ...q,
    skills,
    canonicalSkills: canonicalSkillLabels(skills),
  });
  const addSkill = (skill: string) =>
    onChange((q) => withSkills(q, [...q.skills, skill]));
  const removeSkill = (skill: string) =>
    onChange((q) => withSkills(q, q.skills.filter((s) => s !== skill)));

  const addExcludeTerm = (term: string) =>
    onChange((q) => ({ ...q, excludeTerms: [...(q.excludeTerms ?? []), term] }));
  const removeExcludeTerm = (term: string) =>
    onChange((q) => ({
      ...q,
      excludeTerms: (q.excludeTerms ?? []).filter((t) => t !== term),
    }));

  // Role families (#568): REMOVAL only — see RoleFamilyChips' doc for why
  // there's no free-text add. Narrowing to an empty list is safe: readers
  // resolve `families: []` to the permissive "all" filter, never zero results.
  const removeRoleFamily = (family: RoleFamily) =>
    onChange((q) => ({
      ...q,
      families: (q.families ?? []).filter((f) => f !== family),
    }));

  const setLevel = (level: string | undefined) =>
    onChange((q) => ({ ...q, seniority: level }));

  // Term quality (#585): pure classification, computed fresh each render off
  // the current `query` — `assessQueryTerms` is total and cheap (no I/O), so
  // no memoization is warranted. `ChipListEditor` stays display-only: it
  // looks up a verdict by chip text, it never classifies.
  const assessment = assessQueryTerms(query);
  const titleVerdicts = new Map(
    assessment.verdicts.filter((v) => v.kind === "title").map((v) => [v.term, v]),
  );
  const skillVerdicts = new Map(
    assessment.verdicts.filter((v) => v.kind === "skill").map((v) => [v.term, v]),
  );
  // Adding a missing term to the QUERY, never the résumé (#585) — a plain
  // whole-query replacement through the same `onChange` every other handler
  // here uses, so it rides the live re-rank with no refetch. `missingTermLabel`
  // is the same mapping `TermQualityAdvisory` rendered the pill with, so the
  // text the user clicked is exactly the text that lands in the query.
  const addMissingTerm = (term: MissingTerm) => {
    const label = missingTermLabel(term);
    onChange((q) =>
      term.kind === "title"
        ? { ...q, titles: [...q.titles, label] }
        : withSkills(q, [...q.skills, label]),
    );
  };

  const hasChips = query.titles.length > 0 || query.skills.length > 0;

  return (
    <>
      <StepPanel id="role">
        <QueryStepSection
          title="Titles"
          hint={ROLE_HINT}
        >
          <ChipListEditor
            label="Your titles"
            labelHidden
            items={query.titles}
            onAdd={addTitle}
            onRemove={removeTitle}
            placeholder="Add a title…"
            addAriaLabel="Add title"
            primaryIndex={query.titles.length > 0 ? 0 : undefined}
            onPromote={(title) => onChange((q) => promoteTitle(q, title))}
            qualityFor={(item) => titleVerdicts.get(item)}
          />
          {query.titles.length > 0 && <TermGlyphLegend />}
          {/* #597: the suggestions sit under the list they write into, not in a
           *  trailing section the user has to connect back up. */}
          <TermQualityAdvisory
            kind="title"
            missing={assessment.missing}
            onAdd={addMissingTerm}
          />
        </QueryStepSection>

        {/* Target level (#562/#568): progressive disclosure, same pattern as
         *  pre-#568 free-text Seniority — a résumé whose titles carry no
         *  recognized level renders no inert control until the user opts in.
         *  Changing the level re-runs the #562 rung-distance penalty (live, via
         *  the workbench's refinement effect). It sits with Role rather than in
         *  Narrow because it is derived FROM a title and its provenance line
         *  names that title — the two are unreadable apart. */}
        <QueryStepSection title="Target level">
          {query.seniority || seniorityExpanded ? (
            <LevelSelect value={query.seniority} onChange={setLevel} />
          ) : (
            <AddPill label="Target level" onClick={() => setSeniorityExpanded(true)} />
          )}
          {/* #581: names the title `deriveSeniorityAcrossTitles` matched, so an
           *  overridable derived value is explicable rather than a new lever.
           *  Absent once the user overrides to a level no title produces. */}
          {seniorityProvenance(query) && (
            <p className="text-sm text-content-secondary">
              {query.seniority} — from &quot;{seniorityProvenance(query)}&quot;
            </p>
          )}
        </QueryStepSection>

        {/* Role families (#568): seeded from the same classification the
         *  company-board pipeline uses, removable so a fullstack résumé that
         *  also matched `data` can drop it. */}
        <QueryStepSection title="Role family">
          <RoleFamilyChips
            families={(query.families ?? []) as RoleFamily[]}
            onRemove={removeRoleFamily}
          />
        </QueryStepSection>
      </StepPanel>

      <StepPanel id="skills">
        <QueryStepSection
          title="Skills"
          hint="The starred skill is sent as the topic tag. The rest rank how well each posting fits you, on your device."
        >
          {/* Skills carry a primary too (#597): `primaryKeyword` sends
           *  `skills[0]` as the topic tag, so the `★` control means the same
           *  thing here as on Titles — hence the same opt-in pair, with the noun
           *  the label needs. */}
          <ChipListEditor
            label="Your skills"
            labelHidden
            items={query.skills}
            onAdd={addSkill}
            onRemove={removeSkill}
            placeholder="Add a skill…"
            addAriaLabel="Add skill"
            primaryIndex={query.skills.length > 0 ? 0 : undefined}
            onPromote={(skill) => onChange((q) => promoteSkill(q, skill))}
            primaryNoun="skill"
            qualityFor={(item) => skillVerdicts.get(item)}
          />
          {query.skills.length > 0 && <TermGlyphLegend />}
          <TermQualityAdvisory
            kind="skill"
            missing={assessment.missing}
            onAdd={addMissingTerm}
          />
        </QueryStepSection>
      </StepPanel>

      <StepPanel id="filters">
        {/* Location (#545): always shown, unlike the target level's
         *  AddPill-gated disclosure — location is a primary axis of every
         *  job-board search form (not an auxiliary facet the way level is),
         *  and a résumé with no parsed location still needs a visible place
         *  to type one to get any location-aware ranking or deep-link
         *  behavior at all. */}
        <QueryStepSection title="Location">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
            <EditableField
              value={query.location}
              placeholder="location"
              label="Location"
              onCommit={(v) => onChange((q) => ({ ...q, location: v || undefined }))}
            />
          </div>
        </QueryStepSection>

        {/* Exclude (#563): title-only — a posting is dropped when its TITLE
         *  contains one of these, never when only its description does.
         *  Removable chips may already be seeded from the role-family
         *  classification (e.g. GTM/field roles for an engineering search). */}
        <QueryStepSection
          title="Exclude"
          hint="A posting is dropped when its title contains one of these — its description is not checked."
        >
          <ChipListEditor
            label="Excluded titles"
            labelHidden
            items={query.excludeTerms ?? []}
            onAdd={addExcludeTerm}
            onRemove={removeExcludeTerm}
            placeholder="Add a title to exclude…"
            addAriaLabel="Add exclude term"
          />
        </QueryStepSection>

        <QueryStepSection title="Minimum pay">
          <CompFloorInput
            value={query.compFloor}
            onCommit={(v) => onChange((q) => ({ ...q, compFloor: v }))}
          />
        </QueryStepSection>

        {/* #602: the company picker moved from a permanent band above the form
         *  into the step it belongs to. It was pinned there (pre-#602) so it
         *  would survive the post-search fold; `JobQuerySummary` already
         *  carries the selected count through that fold, so the readout it was
         *  protecting is not lost — and as a lone unheaded grey sentence at the
         *  top of the page it was the least legible control on the form. */}
        <QueryStepSection title="Company boards">
          <CompanyTargets targets={companyTargets} />
        </QueryStepSection>
      </StepPanel>

      <StepPanel id="review">
        {/* Contract first: this is the block the whole form leads up to, and
         *  before #602 it rendered below every field instead of above the
         *  button it describes. The pickers call the SAME promote reducers the
         *  chip rows' `★` control calls — one mutation path, and every reorder
         *  is a click the user made. */}
        <SearchPlanCard
          query={query}
          companyCount={companyTargets.selected.length}
          onPromoteTitle={(title) => onChange((q) => promoteTitle(q, title))}
          onPromoteSkill={(skill) => onChange((q) => promoteSkill(q, skill))}
        />

        {/* Whole-query findings: the #587 coherence note and the #597 dropped
         *  terms. The per-kind suggestions render in their own steps instead,
         *  so `missing` is deliberately not passed here. Renders nothing when
         *  it has nothing to say, including the unresolved-role case — no
         *  "we couldn't identify your role" nag, no all-clear. */}
        <TermQualityAdvisory
          coherence={assessment.coherence}
          dropped={assessment.verdicts}
          onAdd={addMissingTerm}
        />

        {/* Legend repeated here only when the findings above can render a mark
         *  the user has not seen in context. */}
        {hasChips && <TermGlyphLegend />}

        <QueryStepSection title="Search somewhere else">
          <ExternalBoardLinks links={links} />
        </QueryStepSection>

        {isDegenerate && (
          <p className="max-w-prose text-sm text-content-secondary">
            We couldn&apos;t derive a search from this resume — add a title or
            skills to search.
          </p>
        )}
      </StepPanel>
    </>
  );
}

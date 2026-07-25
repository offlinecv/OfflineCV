// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobQueryEditor — the editable search query of the job-search workbench.
 *
 * Extracted verbatim out of `FindJobsPanel` when the results moved to their own
 * `/jobs/` page: the panel became a foldable full-width search form above the
 * results, and the fields shouldn't own the layout that folds them. Nothing
 * about the controls changed in the move.
 *
 * The fields lay themselves out across the full width rather than stacking in one
 * narrow column: the panel hands this component the whole page, and a single
 * column would leave a ~470px form on a 1080px page — which is what the layout
 * looked like when the neighbouring blocks owned the other columns.
 *
 * Grouping is by how the fields are used, not by size: what you SEARCH FOR
 * (titles + role) and what you're MADE OF (skills) get a column each, because
 * both are long removable-chip lists; the narrow modifiers (location, exclude,
 * pay floor) share the third. Target level spans the full width on its own row —
 * it's a 12-rung segmented control that would wrap into three ragged lines inside
 * a third of the page.
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
import { EditableField } from "@design-system";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";
import { parseSeniorityLabel } from "../../lib/job-search/query-builder.ts";
import { searchPhrase } from "../../lib/job-search/providers/keywords.ts";
import type { RoleFamily } from "../../lib/job-search/role-keywords.ts";
import { ChipListEditor } from "./ChipListEditor.tsx";
import { CompFloorInput } from "./CompFloorInput.tsx";
import { RoleFamilyChips } from "./RoleFamilyChips.tsx";
import { LevelSelect } from "./LevelSelect.tsx";
import { AddPill } from "./ReconstructedAdd.tsx";

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
}: {
  query: JobQuery;
  onChange: (next: (q: JobQuery) => JobQuery) => void;
  /** True when the parse yielded neither a title nor a skill — the search
   *  cannot run, and the hint below tells the user what to type. */
  isDegenerate: boolean;
}) {
  // Progressive disclosure for Seniority (#540): a résumé whose titles carry
  // no recognized seniority keyword renders no inert placeholder field — the
  // row appears only once a seniority was derived, or the user opts in via
  // the "+ Seniority" pill. Purely presentational, so it stays local here.
  const [seniorityExpanded, setSeniorityExpanded] = useState(false);

  // ChipListEditor already trims + case-insensitively dedups before calling
  // onAdd, so these handlers just append / filter the controlled list.
  const addTitle = (title: string) =>
    onChange((q) => ({ ...q, titles: [...q.titles, title] }));
  const removeTitle = (title: string) =>
    onChange((q) => ({ ...q, titles: q.titles.filter((t) => t !== title) }));
  // Promote (#581): move-to-front of `titles`, a whole-query replacement that
  // touches nothing else on `q` — `titleNoise` (#579) is a derived,
  // non-user-facing field on the same object and must survive untouched, so
  // this spreads `q` rather than rebuilding it. Rides the existing `onChange`
  // → live re-rank path, so promoting never refetches.
  const promoteTitle = (title: string) =>
    onChange((q) => {
      const index = q.titles.indexOf(title);
      if (index <= 0) return q; // already primary, or not found
      return {
        ...q,
        titles: [title, ...q.titles.slice(0, index), ...q.titles.slice(index + 1)],
      };
    });

  const addSkill = (skill: string) =>
    onChange((q) => ({ ...q, skills: [...q.skills, skill] }));
  const removeSkill = (skill: string) =>
    onChange((q) => ({ ...q, skills: q.skills.filter((s) => s !== skill) }));

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

  /** The literal string that egresses to the keyless feeds — empty when the
   *  query carries neither a title nor a skill. */
  const egressPhrase = searchPhrase(query);

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-3">
        <ChipListEditor
          label="Titles"
          items={query.titles}
          onAdd={addTitle}
          onRemove={removeTitle}
          placeholder="Add a title…"
          addAriaLabel="Add title"
          primaryIndex={query.titles.length > 0 ? 0 : undefined}
          onPromote={promoteTitle}
        />
        {/* #581: this reads the SAME `searchPhrase` the keyless feeds are
         *  called with, rather than a copy, so it can never drift from what
         *  actually egresses. Gated on the phrase itself being non-empty, NOT
         *  on `titles.length` — with no title `searchPhrase` falls back to
         *  `skills.slice(0, 3)`, so gating on titles hid this line in the one
         *  case where skills are what egress. */}
        {egressPhrase.length > 0 && (
          <p className="text-xs text-content-tertiary">
            Searching feeds for &quot;{egressPhrase}&quot;
          </p>
        )}
        {/* Role families (#568): seeded from the same classification the
         *  company-board pipeline uses, removable so a fullstack résumé that
         *  also matched `data` can drop it. */}
        <RoleFamilyChips
          families={(query.families ?? []) as RoleFamily[]}
          onRemove={removeRoleFamily}
        />
      </div>

      <ChipListEditor
        label="Skills"
        items={query.skills}
        onAdd={addSkill}
        onRemove={removeSkill}
        placeholder="Add a skill…"
        addAriaLabel="Add skill"
      />

      <div className="flex flex-col gap-3">
        {/* Location (#545): always shown, unlike the target level's
         *  AddPill-gated disclosure — location is a primary axis of every
         *  job-board search form (not an auxiliary facet the way level is),
         *  and a résumé with no parsed location still needs a visible place
         *  to type one to get any location-aware ranking or deep-link
         *  behavior at all. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-xs text-content-tertiary">Location</span>
          <EditableField
            value={query.location}
            placeholder="location"
            label="Location"
            onCommit={(v) => onChange((q) => ({ ...q, location: v || undefined }))}
          />
        </div>
        {/* Exclude (#563): title-only — a posting is dropped when its TITLE
         *  contains one of these, never when only its description does.
         *  Removable chips may already be seeded from the role-family
         *  classification (e.g. GTM/field roles for an engineering search). */}
        <ChipListEditor
          label="Exclude (title only)"
          items={query.excludeTerms ?? []}
          onAdd={addExcludeTerm}
          onRemove={removeExcludeTerm}
          placeholder="Add a title to exclude…"
          addAriaLabel="Add exclude term"
        />
        <CompFloorInput
          value={query.compFloor}
          onCommit={(v) => onChange((q) => ({ ...q, compFloor: v }))}
        />
      </div>

      {/* Target level (#562/#568): progressive disclosure, same pattern as
       *  pre-#568 free-text Seniority — a résumé whose titles carry no
       *  recognized level renders no inert control until the user opts in
       *  via "+ Seniority". Changing the level re-runs the #562 rung-
       *  distance penalty (live, via the workbench's refinement effect).
       *  Full-width row: 12 rungs wrap badly inside a third of the page. */}
      <div className="sm:col-span-2 lg:col-span-3 flex flex-col gap-1">
        {query.seniority || seniorityExpanded ? (
          <LevelSelect value={query.seniority} onChange={setLevel} />
        ) : (
          <AddPill label="Target level" onClick={() => setSeniorityExpanded(true)} />
        )}
        {/* #581: names the title `deriveSeniorityAcrossTitles` matched, so an
         *  overridable derived value is explicable rather than a new lever.
         *  Absent once the user overrides to a level no title produces. */}
        {seniorityProvenance(query) && (
          <p className="text-xs text-content-tertiary">
            {query.seniority} — from &quot;{seniorityProvenance(query)}&quot;
          </p>
        )}
      </div>

      {isDegenerate && (
        <p className="text-xs text-content-tertiary sm:col-span-2 lg:col-span-3">
          We couldn&apos;t derive a search from this resume — add a title or
          skills to search.
        </p>
      )}
    </div>
  );
}

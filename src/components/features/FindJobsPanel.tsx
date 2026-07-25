// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FindJobsPanel — first slice of the job-search lane (#318). Builds a search
 * query from the parsed resume, lets the user edit it, and renders inert
 * deep-link buttons to major job boards. Zero network calls: deep links open
 * in a new tab under the user's own navigation; nothing here fetches.
 *
 * This is the STABLE SKELETON for the whole "Find Jobs" panel arc (epic
 * #317): header + Query block + Actions row (see the UX spec at
 * `find-jobs-ux-spec.md`). Slice #319 appends a Search button + Results
 * region below the Actions row; slice #320 appends a BYOK footer. Neither
 * restructures what this slice ships — only append here.
 *
 * The query is local, scratch-editable state seeded once from the parse; it
 * intentionally does NOT write back into the résumé override model
 * (useEditableParse) — editing the search query is not editing the résumé.
 */

import { useMemo, useState } from "react";
import { Button, EditableField } from "@design-system";
import { buildJobQuery, type JobQuery } from "../../lib/job-search/query-builder.ts";
import { buildDeepLinks } from "../../lib/job-search/deep-links.ts";
import {
  roleFilterForResume,
  seedExcludeTermsForFamilies,
  type RoleFamily,
} from "../../lib/job-search/role-keywords.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import { JobSearchResults } from "./JobSearchResults.tsx";
import { ChipListEditor } from "./ChipListEditor.tsx";
import { CompFloorInput } from "./CompFloorInput.tsx";
import { RoleFamilyChips } from "./RoleFamilyChips.tsx";
import { LevelSelect } from "./LevelSelect.tsx";
import { CompanyTargets } from "./CompanyTargets.tsx";
import { useCompanyTargets } from "../../hooks/useCompanyTargets.ts";
import { useJobSearch } from "../../hooks/useJobSearch.ts";
import { AddPill } from "./ReconstructedAdd.tsx";

interface FindJobsPanelProps {
  /** The live cascade's parsed résumé. `buildJobQuery` reads only titles/skills;
   *  the fit-ranking (via `searchJobs`) needs the fuller shape (summary,
   *  education) for accurate coverage, so we take the whole `HeuristicParsedResume`
   *  rather than the narrow query-only Pick. */
  parsed: HeuristicParsedResume;
}

export function FindJobsPanel({ parsed }: FindJobsPanelProps) {
  // Seed local query state from the parse once (lazy initializer — runs only
  // on mount); the user edits it from here. Exclude-term chips (#563) AND
  // role-family chips (#568) are seeded from the SAME role-family
  // classification the company-board pipeline derives — visibly, as ordinary
  // removable chips below, never applied invisibly.
  const [query, setQuery] = useState<JobQuery>(() => {
    const roleFilter = roleFilterForResume(parsed);
    return buildJobQuery(
      parsed,
      seedExcludeTermsForFamilies(roleFilter.families),
      roleFilter.families,
    );
  });
  // Progressive disclosure for Seniority (#540): a résumé whose titles carry
  // no recognized seniority keyword renders no inert placeholder field — the
  // row appears only once a seniority was derived, or the user opts in via
  // the "+ Seniority" pill.
  const [seniorityExpanded, setSeniorityExpanded] = useState(false);

  const links = useMemo(() => buildDeepLinks(query), [query]);
  const isDegenerate = query.titles.length === 0 && query.skills.length === 0;

  // ChipListEditor already trims + case-insensitively dedups before calling
  // onAdd, so these handlers just append / filter the controlled list.
  const addTitle = (title: string) =>
    setQuery((q) => ({ ...q, titles: [...q.titles, title] }));
  const removeTitle = (title: string) =>
    setQuery((q) => ({ ...q, titles: q.titles.filter((t) => t !== title) }));

  const addSkill = (skill: string) =>
    setQuery((q) => ({ ...q, skills: [...q.skills, skill] }));
  const removeSkill = (skill: string) =>
    setQuery((q) => ({ ...q, skills: q.skills.filter((s) => s !== skill) }));

  const addExcludeTerm = (term: string) =>
    setQuery((q) => ({ ...q, excludeTerms: [...(q.excludeTerms ?? []), term] }));
  const removeExcludeTerm = (term: string) =>
    setQuery((q) => ({
      ...q,
      excludeTerms: (q.excludeTerms ?? []).filter((t) => t !== term),
    }));

  // Role families (#568): REMOVAL only — see RoleFamilyChips' doc for why
  // there's no free-text add. Narrowing to an empty list is safe: readers
  // resolve `families: []` to the permissive "all" filter, never zero results.
  const removeRoleFamily = (family: RoleFamily) =>
    setQuery((q) => ({
      ...q,
      families: (q.families ?? []).filter((f) => f !== family),
    }));

  const setLevel = (level: string | undefined) =>
    setQuery((q) => ({ ...q, seniority: level }));

  // Sector-suggested companies whose ATS boards join the fan-out. Selecting
  // none is a supported state: the search falls back to the keyless feeds
  // alone, exactly as it behaved before #533.
  const companyTargets = useCompanyTargets(parsed);
  const selectedCompanies = companyTargets.selected;

  // Fetch lifecycle + #568's live re-rank — see the hook's own docblock.
  const { phase, runSearch, isLoading } = useJobSearch(query, parsed, selectedCompanies);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Find jobs
          </h2>
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-content-secondary">
            alpha
          </span>
        </div>
        <p className="max-w-prose text-xs text-content-tertiary">
          We built this search from your parsed resume. Edit it, then search
          job boards. Your resume text never leaves this browser — only the
          keywords below are sent.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <ChipListEditor
          label="Titles"
          items={query.titles}
          onAdd={addTitle}
          onRemove={removeTitle}
          placeholder="Add a title…"
          addAriaLabel="Add title"
        />
        {/* Role families (#568): seeded from the same classification the
         *  company-board pipeline uses, removable so a fullstack résumé that
         *  also matched `data` can drop it. */}
        <RoleFamilyChips
          families={(query.families ?? []) as RoleFamily[]}
          onRemove={removeRoleFamily}
        />
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
            onCommit={(v) =>
              setQuery((q) => ({ ...q, location: v || undefined }))
            }
          />
        </div>
        {/* Target level (#562/#568): progressive disclosure, same pattern as
         *  pre-#568 free-text Seniority — a résumé whose titles carry no
         *  recognized level renders no inert control until the user opts in
         *  via "+ Seniority". Changing the level re-runs the #562 rung-
         *  distance penalty (live, via the refinement effect above). */}
        {query.seniority || seniorityExpanded ? (
          <LevelSelect value={query.seniority} onChange={setLevel} />
        ) : (
          <AddPill label="Target level" onClick={() => setSeniorityExpanded(true)} />
        )}
        <ChipListEditor
          label="Skills"
          items={query.skills}
          onAdd={addSkill}
          onRemove={removeSkill}
          placeholder="Add a skill…"
          addAriaLabel="Add skill"
        />
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
          onCommit={(v) => setQuery((q) => ({ ...q, compFloor: v }))}
        />
        {isDegenerate && (
          <p className="text-xs text-content-tertiary">
            We couldn&apos;t derive a search from this resume — add a title or
            skills above to search.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-content-tertiary">
          Search external boards
        </span>
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-subtle focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              {link.label}
              <span aria-hidden="true">↗</span>
            </a>
          ))}
        </div>
        <p className="text-xs text-content-tertiary">
          Only your search keywords are sent, and only when you click a link
          above.
        </p>
      </div>

      <CompanyTargets targets={companyTargets} />

      <div className="flex flex-col gap-2">
        <div>
          <Button
            variant="primary"
            size="md"
            onClick={runSearch}
            disabled={isDegenerate || isLoading}
          >
            {isLoading ? "Searching…" : "Search jobs"}
          </Button>
        </div>
        <p className="text-xs text-content-tertiary">
          Only your search keywords are sent, and only when you click Search.
        </p>
      </div>

      <JobSearchResults phase={phase} onRetry={runSearch} />
    </div>
  );
}

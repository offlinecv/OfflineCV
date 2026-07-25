// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FindJobsPanel — the job-search workbench body, the whole of `/jobs/`.
 *
 * It used to be a tab on `/` with the results stacked underneath the query, at
 * the bottom of a long parser-audit page. Results moved to their own entry
 * (`jobs/index.html`) because a ranked list of dozens of postings is a
 * destination, not a footnote: it needs a URL you can reload, its own scroll,
 * and the full page width. `/` keeps `FindJobsLauncher`, which hands the parse
 * over via `lib/jobs-handoff.ts`.
 *
 * LAYOUT: full-width bands stacked down the page, never a sidebar. Reading order
 * is the order of the work — who we search, then what we search for, then what we
 * found:
 *
 *  1. **Company targets, permanent.** The one query control that stays visible
 *     with the results. It's the axis users retune WHILE reading postings ("drop
 *     that one, add this one"), and #533's toggle is now live against an existing
 *     result set, so hiding it behind a fold would bury the panel's most
 *     immediate feedback loop.
 *  2. **The rest of the query, foldable.** Titles, skills, location, level,
 *     excludes, pay floor, external boards — a form, worth the full page width
 *     while being filled in and worth none of it afterwards. Folded, it is a
 *     one-line `JobQuerySummary` + Search again.
 *  3. **Results**, owning the full width.
 *
 * Folding on submit rather than on the first successful result is deliberate:
 * the transition is then tied to the user's own click, so it never happens under
 * their cursor a second later, and the loading skeleton already gets the full
 * width it will render results into. A failed search stays folded too — its
 * error state carries Retry, and Edit search is one click away.
 *
 * Nothing is sticky. With the company chips permanently on top, a pinned band
 * would be ~3 chip rows tall and would cost more viewport on every scroll than
 * the Search button it keeps in reach is worth.
 *
 * #568's live re-rank means a refinement chip edited while the panel is open
 * updates the results with no refetch, so re-opening the form over a results set
 * is a cheap, non-destructive thing to do. The company selector is the one
 * control that can outrun the results — removing a target re-filters live, but
 * ADDING one needs its board fetched, which is what `PendingCompaniesNotice`
 * offers rather than doing on the checkbox click.
 *
 * Still a layout shell: the query fields are `JobQueryEditor`, the deep links
 * `ExternalBoardLinks`, the fetch lifecycle `useJobSearch`, the company picker
 * `useCompanyTargets`. The query state is owned HERE because the editor, the
 * ranking, and the re-rank effect all read it.
 */

import { useMemo, useState } from "react";
import { Button } from "@design-system";
import { buildJobQuery, type JobQuery } from "../../lib/job-search/query-builder.ts";
import { buildDeepLinks } from "../../lib/job-search/deep-links.ts";
import {
  roleFilterForResume,
  seedExcludeTermsForFamilies,
} from "../../lib/job-search/role-keywords.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import { JobSearchResults } from "./JobSearchResults.tsx";
import { JobQueryEditor } from "./JobQueryEditor.tsx";
import { JobQuerySummary } from "./JobQuerySummary.tsx";
import { ExternalBoardLinks } from "./ExternalBoardLinks.tsx";
import { PendingCompaniesNotice } from "./PendingCompaniesNotice.tsx";
import { CompanyTargets } from "./CompanyTargets.tsx";
import { useCompanyTargets } from "../../hooks/useCompanyTargets.ts";
import { useJobSearch } from "../../hooks/useJobSearch.ts";

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
  // removable chips, never applied invisibly.
  const [query, setQuery] = useState<JobQuery>(() => {
    const roleFilter = roleFilterForResume(parsed);
    return buildJobQuery(
      parsed,
      seedExcludeTermsForFamilies(roleFilter.families),
      roleFilter.families,
    );
  });

  // Open until the first Search, then folded — see the docblock. Purely
  // presentational, so it stays local rather than moving to a hook.
  const [open, setOpen] = useState(true);

  const links = useMemo(() => buildDeepLinks(query), [query]);
  const isDegenerate = query.titles.length === 0 && query.skills.length === 0;

  // Sector-suggested companies whose ATS boards join the fan-out. Selecting
  // none is a supported state: the search falls back to the keyless feeds
  // alone, the same way it behaved before #533.
  const companyTargets = useCompanyTargets(parsed);
  const selectedCompanies = companyTargets.selected;

  // Fetch lifecycle, #568's live re-rank, and the asymmetric company handling
  // (remove = live, add = a prompt) — see the hook's own docblock.
  const {
    phase,
    runSearch,
    isLoading,
    pendingCompanies,
    searchPendingCompanies,
    isUpdating,
  } = useJobSearch(query, parsed, selectedCompanies);
  const hasSearched = phase.kind !== "idle";

  const submit = () => {
    setOpen(false);
    runSearch();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Band 1 — the only query control that outlives the fold. */}
      <CompanyTargets targets={companyTargets} />

      <section
        aria-label="Job search query"
        className="flex flex-col gap-3 border-y border-border-light py-3"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide search details" : "Edit search"}
          </Button>
          {!open && (
            <JobQuerySummary
              query={query}
              companyCount={selectedCompanies.length}
            />
          )}
          <Button
            variant="primary"
            size="md"
            className="ml-auto"
            onClick={submit}
            disabled={isDegenerate || isLoading}
          >
            {isLoading
              ? "Searching…"
              : hasSearched
                ? "Search again"
                : "Search jobs"}
          </Button>
        </div>

        {/* Sits under the Search button rather than at the foot of the section:
         *  the claim is about what THAT button does, and `ExternalBoardLinks`
         *  carries its own (different) claim about the deep links. */}
        <p className="text-xs text-content-tertiary">
          Only your search keywords are sent, and only when you click Search.
        </p>

        {open && (
          <div className="flex flex-col gap-4">
            <JobQueryEditor
              query={query}
              onChange={setQuery}
              isDegenerate={isDegenerate}
            />
            <ExternalBoardLinks links={links} />
          </div>
        )}
      </section>

      {/* Only over an existing result set: before the first search every
       *  selected company is unsearched, which is not news. */}
      {phase.kind === "loaded" && (
        <PendingCompaniesNotice
          companies={pendingCompanies}
          onSearch={searchPendingCompanies}
          isUpdating={isUpdating}
        />
      )}

      <JobSearchResults phase={phase} onRetry={runSearch} />
    </div>
  );
}

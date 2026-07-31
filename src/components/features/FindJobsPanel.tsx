// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FindJobsPanel — the job-search workbench body: the Search view of `/jobs/`
 * (as of #690, one of two peer `Tabs` views — the other is the saved-jobs
 * library — rather than the whole page).
 *
 * It used to be a tab on `/` with the results stacked underneath the query, at
 * the bottom of a long parser-audit page. Results moved to their own entry
 * (`jobs/index.html`) because a ranked list of dozens of postings is a
 * destination, not a footnote: it needs a URL you can reload, its own scroll,
 * and the full page width. `/` keeps `FindJobsLauncher`, which hands the parse
 * over via `lib/jobs-handoff.ts`.
 *
 * LAYOUT: full-width bands stacked down the page, never a sidebar.
 *
 *  1. **The query, as an ordered four-step walk** (#602) — Role → Skills →
 *     Narrow → Review, on the `Stepper` composition. The pre-#602 form put
 *     every field on screen at once in a three-column grid: ~40 chips, a
 *     12-rung level rail, a mark legend, an advisory block, the deep links and
 *     the outbound contract, all at one typographic weight with no headings.
 *     Everything was reachable and nothing was findable. The steps ARE the
 *     reading order of the work, and each rail entry states its own current
 *     value (`describeQuerySteps`), so a closed step is still legible.
 *  2. **Results**, owning the full width.
 *
 * The whole query folds to a one-line `JobQuerySummary` + Search again on
 * submit — the rail included, since a form worth the full page width while
 * being filled in is worth none of it afterwards.
 *
 * ORDER IS CAUSE → CONTRACT → ACTION (#597, kept by #602). The fields come
 * first, then `SearchPlanCard` at the head of the Review step — which single
 * title and which single skill will actually leave the browser, with a
 * **change** control on each — and then Search. Before #597 the button floated
 * top-right, where a user read the outbound terms (if at all) after clicking
 * rather than before; before #602 the contract card rendered at the FOOT of the
 * form, below every field it describes.
 *
 * The Search button is mounted on every step (`StepperNav`'s `finalAction`), not
 * gated behind reaching Review: the query arrives already seeded, so a user who
 * is happy with it must never have to walk four steps to run it. Its fixed
 * position at the end of the nav row is what marks it as the end of the flow.
 *
 * The plan card carries the ONE form-level statement of what is sent and when.
 * `ExternalBoardLinks` and `CompanyTargets` keep their own sentences — those are
 * different triggers (clicking a deep link; reading a company board), and
 * deleting them would leave those egress paths unexplained.
 *
 * Folding on submit rather than on the first successful result is deliberate:
 * the transition is then tied to the user's own click, so it never happens under
 * their cursor a second later, and the loading skeleton already gets the full
 * width it will render results into. A failed search stays folded too — its
 * error state carries Retry, and Edit search is one click away.
 *
 * Nothing is sticky: a pinned band tall enough to hold the rail and the nav row
 * would cost more viewport on every scroll than the Search button it keeps in
 * reach is worth.
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
import { Button, Stepper, StepperNav, StepperRail } from "@design-system";
import { buildJobQuery, type JobQuery } from "../../lib/job-search/query-builder.ts";
import { buildDeepLinks } from "../../lib/job-search/deep-links.ts";
import { buildCompanySearchLinks } from "../../lib/job-search/company-search-link.ts";
import {
  describeQuerySteps,
  type QueryStepId,
} from "../../lib/job-search/query-steps.ts";
import {
  roleFilterForResume,
  seedExcludeTermsForFamilies,
} from "../../lib/job-search/role-keywords.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import { JobSearchResults } from "./JobSearchResults.tsx";
import { JobQueryEditor } from "./JobQueryEditor.tsx";
import { JobQuerySummary } from "./JobQuerySummary.tsx";
import { PendingCompaniesNotice } from "./PendingCompaniesNotice.tsx";
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

  // Which step of the query walk is showing (#602). Also presentational; the
  // query itself is the state that matters and lives above.
  const [step, setStep] = useState<QueryStepId>("role");

  const links = useMemo(() => buildDeepLinks(query), [query]);
  // Deep links into major self-hosted-careers employers' OWN search pages
  // (#691) — a separate, static registry from the board links above; see
  // `company-search-link.ts`'s docblock for why it doesn't touch `useJobSearch`
  // or `buildSearchPlan`.
  const companySearchLinks = useMemo(() => buildCompanySearchLinks(query), [query]);
  const isDegenerate = query.titles.length === 0 && query.skills.length === 0;

  // Sector-suggested companies whose ATS boards join the fan-out. Selecting
  // none is a supported state: the search falls back to the keyless feeds
  // alone, the same way it behaved before #533.
  const companyTargets = useCompanyTargets(parsed);
  const selectedCompanies = companyTargets.selected;

  // Pure string assembly over already-derived values (see `query-steps.ts`), so
  // no memoization is warranted; it must recompute on every query edit anyway,
  // which is what makes a closed step's summary trustworthy.
  const steps = describeQuerySteps(query, selectedCompanies.length);

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

  // One Search button, rendered in two different places by the fold — declared
  // once so the disabled rule and the label cannot drift between them.
  const searchButton = (
    <Button
      variant="primary"
      size="md"
      onClick={submit}
      disabled={isDegenerate || isLoading}
    >
      {isLoading ? "Searching…" : hasSearched ? "Search again" : "Search jobs"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Job search query"
        className="flex flex-col gap-3 border-y border-border-light py-3"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="ghost"
            size="md"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide search details" : "Edit search"}
          </Button>
          {!open && (
            <>
              <JobQuerySummary
                query={query}
                companyCount={selectedCompanies.length}
              />
              <div className="ml-auto">{searchButton}</div>
            </>
          )}
        </div>

        {open && (
          <Stepper
            id="job-query"
            value={step}
            onValueChange={(next) => setStep(next as QueryStepId)}
            steps={steps}
          >
            <StepperRail aria-label="Search steps" />
            <JobQueryEditor
              query={query}
              onChange={setQuery}
              isDegenerate={isDegenerate}
              links={links}
              companySearchLinks={companySearchLinks}
              companyTargets={companyTargets}
            />
            <StepperNav finalAction={searchButton} />
          </Stepper>
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

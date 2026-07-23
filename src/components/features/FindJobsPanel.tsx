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

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EditableField } from "@design-system";
import { buildJobQuery, type JobQuery } from "../../lib/job-search/query-builder.ts";
import { buildDeepLinks } from "../../lib/job-search/deep-links.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import {
  JobSearchResults,
  type SearchPhase,
} from "./JobSearchResults.tsx";
import { ChipListEditor } from "./ChipListEditor.tsx";
import { CompanyTargets } from "./CompanyTargets.tsx";
import { useCompanyTargets } from "../../hooks/useCompanyTargets.ts";
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
  // on mount); the user edits it from here.
  const [query, setQuery] = useState<JobQuery>(() => buildJobQuery(parsed));
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

  // In-app search state. The fetch fires ONLY from runSearch (the Search
  // click) — never on drop, tab open, or query edit. searchJobs dynamic-imports
  // the provider/rank tiers, so nothing job-fetch-related is in the entry chunk.
  const [phase, setPhase] = useState<SearchPhase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const isLoading = phase.kind === "loading";

  // Sector-suggested companies whose ATS boards join the fan-out. Selecting
  // none is a supported state: the search falls back to the keyless feeds
  // alone, exactly as it behaved before #533.
  const companyTargets = useCompanyTargets(parsed);
  const selectedCompanies = companyTargets.selected;

  // Abort any in-flight search on unmount so a late response can't try to
  // update state on an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const runSearch = () => {
    // Supersede any in-flight search so its results can't land after this one.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const { searchJobs } = await import("../../lib/job-search/search.ts");
        const result = await searchJobs(
          query,
          parsed,
          ctrl.signal,
          selectedCompanies,
        );
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "loaded", result });
      } catch {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "failed" });
      }
    })();
  };

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
        {/* Location (#545): always shown, unlike Seniority's AddPill-gated
         *  disclosure — location is a primary axis of every job-board search
         *  form (not an auxiliary facet the way seniority is), and a résumé
         *  with no parsed location still needs a visible place to type one to
         *  get any location-aware ranking or deep-link behavior at all. */}
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
        {query.seniority || seniorityExpanded ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-xs text-content-tertiary">Seniority</span>
            <EditableField
              value={query.seniority}
              placeholder="seniority"
              label="Seniority"
              onCommit={(v) =>
                setQuery((q) => ({ ...q, seniority: v || undefined }))
              }
            />
          </div>
        ) : (
          <AddPill label="Seniority" onClick={() => setSeniorityExpanded(true)} />
        )}
        <ChipListEditor
          label="Skills"
          items={query.skills}
          onAdd={addSkill}
          onRemove={removeSkill}
          placeholder="Add a skill…"
          addAriaLabel="Add skill"
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

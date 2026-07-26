// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobQuerySummary — one line describing the query behind the results shown.
 *
 * `/jobs/` gives the results the full page width by FOLDING the query controls
 * away once a search has run (`FindJobsPanel`). Folding a form the user has just
 * filled in is only safe if what it contained stays legible — otherwise the
 * collapsed state is amnesia, and the user re-expands the panel just to remember
 * what they searched for. This is that legibility: every axis that can change the
 * result set gets a segment, so the summary and the ranking can't silently
 * disagree.
 *
 * Silent axes are OMITTED rather than rendered as "none" — an unset comp floor or
 * an empty exclude list is the neutral default, and printing it would imply a
 * filter is doing work when it isn't. Location is the one exception: it always
 * shows ("anywhere" when unset), because a location-blind search is a result the
 * user will otherwise read as a bug.
 *
 * `summarizeQuery` is exported separately from the component so the segment logic
 * is testable without a DOM.
 *
 * `companyCount` is `undefined` (#581) on the `/` launcher preview, where
 * `useCompanyTargets` has never run — there is no "0 companies selected" to
 * report, only "not computed here". `0` keeps meaning what it always has on
 * `/jobs/`: the user reviewed the suggested boards and kept none.
 */

import type { JobQuery } from "../../lib/job-search/query-builder.ts";

/**
 * Human-readable segments describing `query`, in the order the fields appear in
 * the editor. `companyCount` is the number of selected company boards, which is
 * part of the query's reach but lives outside `JobQuery` (`useCompanyTargets`);
 * omitted entirely when the caller has no count to report (see above).
 */
export function summarizeQuery(
  query: JobQuery,
  companyCount?: number,
): string[] {
  const parts: string[] = [];
  if (query.titles.length > 0) parts.push(query.titles.join(" / "));
  const location = query.location?.trim();
  parts.push(location ? location : "anywhere");
  if (query.seniority) parts.push(query.seniority);
  if (query.skills.length > 0) {
    parts.push(`${query.skills.length} skill${query.skills.length === 1 ? "" : "s"}`);
  }
  const excluded = query.excludeTerms?.length ?? 0;
  if (excluded > 0) parts.push(`${excluded} excluded`);
  if (query.compFloor !== undefined) {
    parts.push(`≥ $${Math.round(query.compFloor / 1000)}k`);
  }
  if (companyCount !== undefined) {
    parts.push(`${companyCount} compan${companyCount === 1 ? "y" : "ies"}`);
  }
  return parts;
}

export function JobQuerySummary({
  query,
  companyCount,
}: {
  query: JobQuery;
  companyCount?: number;
}) {
  return (
    <p className="min-w-0 text-sm text-content-secondary">
      {summarizeQuery(query, companyCount).join(" · ")}
    </p>
  );
}

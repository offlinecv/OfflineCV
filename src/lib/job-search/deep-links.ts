// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * buildDeepLinks — maps a `JobQuery` to prefilled search URLs on major job
 * boards (#318, slice 1 of the job-search epic). Pure function, no I/O; the
 * resulting URLs are rendered as inert `<a target="_blank" rel="noopener
 * noreferrer">` — nothing here fetches anything.
 *
 * Keyword composition: seniority + title + skills, space-joined — with the
 * seniority skipped when the title already contains it (the usual case, since
 * seniority is derived from a title word; see query-builder.ts), so "Senior
 * Backend Engineer" never becomes "Senior Senior Backend Engineer". A fully
 * degenerate query (no title, no skills) still
 * produces valid URLs — LinkedIn/Indeed get an empty query string, Google
 * Jobs falls back to the bare word "jobs" — so the deep-link row never
 * breaks even before the user has typed anything.
 */

import type { JobQuery } from "./query-builder.ts";

export interface JobBoardLink {
  label: string;
  url: string;
}

function buildKeywords(query: JobQuery): string {
  // Seniority is usually DERIVED from a word in the title (query-builder.ts),
  // so prepending it blindly doubles it ("Senior Senior Backend Engineer").
  // Only add it when the title doesn't already carry it (e.g. a user-typed
  // seniority, or an abbreviated title like "Sr. Engineer" with the expanded
  // "Senior" label).
  const seniority =
    query.seniority &&
    !query.title.toLowerCase().includes(query.seniority.toLowerCase())
      ? query.seniority
      : undefined;
  const parts = [seniority, query.title, ...query.skills].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.join(" ");
}

export function buildDeepLinks(query: JobQuery): JobBoardLink[] {
  const keywords = buildKeywords(query);

  const linkedinParams = new URLSearchParams();
  if (keywords) linkedinParams.set("keywords", keywords);

  const indeedParams = new URLSearchParams();
  if (keywords) indeedParams.set("q", keywords);

  const googleParams = new URLSearchParams();
  googleParams.set("q", keywords ? `${keywords} jobs` : "jobs");

  return [
    {
      label: "LinkedIn",
      url: `https://www.linkedin.com/jobs/search/?${linkedinParams.toString()}`,
    },
    {
      label: "Indeed",
      url: `https://www.indeed.com/jobs?${indeedParams.toString()}`,
    },
    {
      label: "Google Jobs",
      url: `https://www.google.com/search?${googleParams.toString()}`,
    },
  ];
}

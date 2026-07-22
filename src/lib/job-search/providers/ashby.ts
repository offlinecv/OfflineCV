// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Ashby ATS-board adapter (job-search v2, epic #528, slice 2 of 5).
 *
 * Parameterized by company slug — `makeAshbyProvider("acme")` returns a
 * `JobProvider` scoped to that company's public board. Ashby has no
 * server-side free-text search and no paging — the whole board comes back
 * in one response. Ashby boards trend smaller, and `?includeCompensation=false`
 * trims the payload; if a board is still large, the #534 title-filter and
 * per-company cap downstream bound what's kept. Like Lever, Ashby already
 * returns a plaintext description (`descriptionPlain`) in the same response,
 * so there is no separate hydrate step — prefer `descriptionPlain`, falling
 * back to HTML-stripping `descriptionHtml` only when plaintext is absent.
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false
 *
 * Response is `{ jobs: [] }`, matching Greenhouse's wrapper shape (Lever's
 * is a top-level array, unlike either of these).
 *
 * Keyless. CORS status: unverified from a browser origin as of this slice —
 * an explicit open task, not a curl check (curl ignores CORS). Verify
 * against real slugs from the dev server before this adapter is wired into
 * `getProviders()` (#533).
 *
 * The request carries only the public company slug and the static
 * `includeCompensation=false` flag — never resume-derived data; `query` is
 * unused here, client-side title-filtering happens downstream in #534.
 */

import type { JobProvider, JobPosting } from "../types.ts";
import { htmlToPlaintext } from "../../jd-match/fetch-jd.ts";

const BASE = "https://api.ashbyhq.com/posting-api/job-board";

interface AshbyJob {
  id?: string;
  title?: string;
  jobUrl?: string;
  location?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedAt?: string;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

function mapJob(slug: string, label: string, job: AshbyJob): JobPosting {
  const departments = [job.department, job.team].filter((d): d is string => Boolean(d));
  return {
    // `ashby:{slug}:{id}` is unique across companies — doubles as the React
    // key and cross-provider dedup id, matching the `provider:id` convention
    // in types.ts. Falls back to the url (guaranteed non-empty by the post-map
    // filter) so two id-less postings never collide on `ashby:{slug}:`,
    // matching remotive.ts/jobicy.ts.
    id: `ashby:${slug}:${job.id ?? job.jobUrl ?? ""}`,
    title: (job.title ?? "").trim(),
    company: label,
    location: (job.location ?? "").trim(),
    url: job.jobUrl ?? "",
    description: job.descriptionPlain ?? htmlToPlaintext(job.descriptionHtml ?? ""),
    postedAt: job.publishedAt,
    source: label,
    departments,
  };
}

/** Factory, not a singleton — one `JobProvider` per company board. */
export function makeAshbyProvider(slug: string, companyName = slug): JobProvider {
  const ID = `ashby:${slug}`;
  const LABEL = companyName;
  return {
    id: ID,
    label: LABEL,
    // Whole board is always fetched (no server-side search, no paging) —
    // narrowing by keyword happens client-side downstream (#534).
    async search(_query, signal: AbortSignal): Promise<JobPosting[]> {
      const url = `${BASE}/${encodeURIComponent(slug)}?includeCompensation=false`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${LABEL} responded ${res.status}`);
      const data = (await res.json()) as AshbyResponse;
      return (data.jobs ?? []).map((j) => mapJob(slug, LABEL, j)).filter((p) => p.title && p.url);
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Greenhouse ATS-board adapter (job-search v2, epic #528, slice 1 of 5).
 *
 * Parameterized by company slug — `makeGreenhouseProvider("stripe")` returns a
 * `JobProvider` scoped to that company's public board. Unlike the keyless
 * feeds (Remotive, Jobicy), Greenhouse's public board API has no server-side
 * free-text search: a company's whole board comes back in one response. To
 * keep that payload bounded regardless of board size, `search()` fetches the
 * **light index** (no `?content=true`) — titles, locations, departments, ids,
 * timestamps, but no `content` blob, so every posting's `description` is `""`.
 * Descriptions are hydrated lazily, per-job, via `hydrateGreenhouse` — called
 * only for postings that survive the #534 title filter and per-company cap.
 *
 *   Light index:  GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
 *   Hydrate one:  GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}
 *
 * Keyless. CORS status: unverified from a browser origin as of this slice —
 * an explicit open task, not a curl check (curl ignores CORS). Verify against
 * real slugs from the dev server before this adapter is wired into
 * `getProviders()` (#533).
 *
 * The request carries only the public company slug/job id — never
 * resume-derived data (no `keywords.ts` involvement); `query` is unused here,
 * client-side title-filtering happens downstream in #534.
 */

import type { JobProvider, JobPosting } from "../types.ts";
import { htmlToPlaintext } from "../../jd-match/fetch-jd.ts";

const BASE = "https://boards-api.greenhouse.io/v1/boards";

interface GreenhouseJob {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  updated_at?: string;
  departments?: { name?: string }[];
  content?: string;
}

interface GreenhouseIndex {
  jobs?: GreenhouseJob[];
}

function mapJob(slug: string, label: string, job: GreenhouseJob): JobPosting {
  return {
    // `greenhouse:{slug}:{jobId}` is unique across companies — doubles as the
    // React key and cross-provider dedup id, matching the `provider:id`
    // convention in types.ts. Falls back to the url (guaranteed non-empty by
    // the post-map filter) so two id-less postings never collide on
    // `greenhouse:{slug}:`, matching remotive.ts/jobicy.ts.
    id: `greenhouse:${slug}:${job.id ?? job.absolute_url ?? ""}`,
    title: (job.title ?? "").trim(),
    company: label,
    location: (job.location?.name ?? "").trim(),
    url: job.absolute_url ?? "",
    // Light index has no content — hydrated lazily via hydrateGreenhouse.
    description: "",
    postedAt: job.updated_at,
    source: label,
    departments: (job.departments ?? [])
      .map((d) => d.name)
      .filter((n): n is string => Boolean(n)),
  };
}

/** Factory, not a singleton — one `JobProvider` per company board. */
export function makeGreenhouseProvider(slug: string, companyName = slug): JobProvider {
  const ID = `greenhouse:${slug}`;
  const LABEL = companyName;
  return {
    id: ID,
    label: LABEL,
    // Whole board is always fetched (no server-side search) — narrowing by
    // keyword happens client-side downstream (#534).
    async search(_query, signal: AbortSignal): Promise<JobPosting[]> {
      const url = `${BASE}/${encodeURIComponent(slug)}/jobs`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${LABEL} responded ${res.status}`);
      const data = (await res.json()) as GreenhouseIndex;
      return (data.jobs ?? []).map((j) => mapJob(slug, LABEL, j)).filter((p) => p.title && p.url);
    },
  };
}

/**
 * Lazy per-job hydrate: fetches one Greenhouse posting and returns its
 * `content` as plaintext. Called only for postings that survive the #534
 * title filter and per-company cap — never for the whole board.
 */
export async function hydrateGreenhouse(
  slug: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${BASE}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Greenhouse job ${jobId} responded ${res.status}`);
  const data = (await res.json()) as GreenhouseJob;
  // htmlToPlaintext decodes HTML entities (named + numeric) and strips tags
  // in one pass, so the HTML-entity-escaped `content` field needs no separate
  // unescape step.
  return htmlToPlaintext(data.content ?? "");
}

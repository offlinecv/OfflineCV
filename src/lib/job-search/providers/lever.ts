// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Lever ATS-board adapter (job-search v2, epic #528, slice 2 of 5).
 *
 * Parameterized by company slug — `makeLeverProvider("acme")` returns a
 * `JobProvider` scoped to that company's public board. Lever has no
 * server-side free-text search either, but it does support server-side
 * paging: `?limit=` caps the fetch instead of pulling an unbounded board.
 * Lever's light response already returns a plaintext description
 * (`descriptionPlain`) inline — prefer it, falling back to HTML-stripping
 * `description` only when plaintext is absent. That inline description is used
 * as-is on a fresh fetch; it is stripped when the board is cached (the cache is
 * light-index only), so a cache hit re-hydrates each survivor via the keyless
 * per-job endpoint below (`hydrateLever`), mirroring Greenhouse.
 *
 *   Light index:  GET https://api.lever.co/v0/postings/{slug}?mode=json&limit=100
 *   Hydrate one:  GET https://api.lever.co/v0/postings/{slug}/{id}?mode=json
 *
 * Response is a **top-level array** (not wrapped in an object), unlike
 * Greenhouse's `{ jobs: [] }` and Ashby's `{ jobs: [] }`.
 *
 * Keyless. CORS status: unverified from a browser origin as of this slice —
 * an explicit open task, not a curl check (curl ignores CORS). Verify
 * against real slugs from the dev server before this adapter is wired into
 * `getProviders()` (#533).
 *
 * The request carries only the public company slug and the static `limit`
 * cap — never resume-derived data; `query` is unused here, client-side
 * title-filtering happens downstream in #534.
 */

import type { JobProvider, JobPosting } from "../types.ts";
import { htmlToPlaintext } from "../../jd-match/fetch-jd.ts";

const BASE = "https://api.lever.co/v0/postings";
const LIMIT = 100;

interface LeverJob {
  id?: string;
  text?: string;
  hostedUrl?: string;
  categories?: {
    location?: string;
    team?: string;
    department?: string;
    commitment?: string;
  };
  descriptionPlain?: string;
  description?: string;
  createdAt?: number;
}

function mapJob(slug: string, label: string, job: LeverJob): JobPosting {
  const departments = [job.categories?.team, job.categories?.department].filter(
    (d): d is string => Boolean(d),
  );
  return {
    // `lever:{slug}:{id}` is unique across companies — doubles as the React
    // key and cross-provider dedup id, matching the `provider:id` convention
    // in types.ts. Falls back to the url (guaranteed non-empty by the post-map
    // filter) so two id-less postings never collide on `lever:{slug}:`,
    // matching remotive.ts/jobicy.ts.
    id: `lever:${slug}:${job.id ?? job.hostedUrl ?? ""}`,
    title: (job.text ?? "").trim(),
    company: label,
    location: (job.categories?.location ?? "").trim(),
    url: job.hostedUrl ?? "",
    description: job.descriptionPlain ?? htmlToPlaintext(job.description ?? ""),
    // `Number.isFinite` (not just `typeof number`) guards `toISOString`, which
    // throws `RangeError` on ±Infinity / |v| > 8.64e15 — cheap insurance so one
    // malformed board row can't abort the whole `.map` in `search()`.
    postedAt: Number.isFinite(job.createdAt)
      ? new Date(job.createdAt as number).toISOString()
      : undefined,
    source: label,
    departments,
  };
}

/** Factory, not a singleton — one `JobProvider` per company board. */
export function makeLeverProvider(slug: string, companyName = slug): JobProvider {
  const ID = `lever:${slug}`;
  const LABEL = companyName;
  return {
    id: ID,
    label: LABEL,
    // Whole board is fetched (no server-side search), capped via `?limit=` —
    // narrowing by keyword happens client-side downstream (#534).
    async search(_query, signal: AbortSignal): Promise<JobPosting[]> {
      const url = `${BASE}/${encodeURIComponent(slug)}?mode=json&limit=${LIMIT}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${LABEL} responded ${res.status}`);
      const data = (await res.json()) as unknown;
      // Lever is the only one of the three boards whose success shape is a
      // bare top-level array, so a 200 carrying an object error envelope (the
      // expected shape for a wrong registry slug) would land straight on
      // `.map`. `Array.isArray` guards that; `?? []` would not.
      const jobs: LeverJob[] = Array.isArray(data) ? (data as LeverJob[]) : [];
      return jobs.map((j) => mapJob(slug, LABEL, j)).filter((p) => p.title && p.url);
    },
  };
}

/**
 * Lazy per-job hydrate: fetches one Lever posting and returns its plaintext
 * description. Called only for survivors whose cached light-index row had its
 * description stripped — never for the whole board.
 *
 * Unlike `hydrateGreenhouse`, this NEVER throws: a hydrate failure (non-ok
 * response, network error, aborted fetch) resolves to `""`. A missing
 * description must cost that one posting its text, never sink the surrounding
 * `mapWithConcurrency` slot — an undescribed posting still ranks and links.
 */
export async function hydrateLever(
  slug: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const url = `${BASE}/${encodeURIComponent(slug)}/${encodeURIComponent(jobId)}?mode=json`;
    const res = await fetch(url, { signal });
    if (!res.ok) return "";
    const data = (await res.json()) as LeverJob;
    return data.descriptionPlain ?? htmlToPlaintext(data.description ?? "");
  } catch {
    return "";
  }
}

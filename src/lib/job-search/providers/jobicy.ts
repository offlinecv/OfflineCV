// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Jobicy adapter — https://jobicy.com/api/v2/remote-jobs?tag=<kw>
 *
 * Keyless, CORS-open (`access-control-allow-origin: *`, verified from a browser
 * origin). Remote-only, tech-skewed. Tag-style query (single keyword), postings
 * under a top-level `jobs` array with camelCase fields.
 */

import type { JobProvider, JobPosting } from "../types.ts";
import type { JobQuery } from "../query-builder.ts";
import { htmlToPlaintext } from "../../jd-match/fetch-jd.ts";
import { primaryKeyword } from "./keywords.ts";

const ENDPOINT = "https://jobicy.com/api/v2/remote-jobs";
const ID = "jobicy";
const LABEL = "Jobicy";

interface JobicyJob {
  id?: number | string;
  jobTitle?: string;
  companyName?: string;
  jobGeo?: string;
  url?: string;
  jobDescription?: string;
  pubDate?: string;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
}

function mapJob(job: JobicyJob): JobPosting {
  return {
    // Fall back to the url (guaranteed non-empty by the post-map filter) so
    // two id-less postings never collide on `jobicy:undefined` — the id doubles
    // as the React key and cross-provider dedup id.
    id: `${ID}:${job.id ?? job.url ?? ""}`,
    title: (job.jobTitle ?? "").trim(),
    company: (job.companyName ?? "").trim(),
    location: (job.jobGeo ?? "").trim(),
    url: job.url ?? "",
    description: htmlToPlaintext(job.jobDescription ?? ""),
    postedAt: job.pubDate,
    source: LABEL,
  };
}

export const jobicyProvider: JobProvider = {
  id: ID,
  label: LABEL,
  async search(query: JobQuery, signal: AbortSignal): Promise<JobPosting[]> {
    const kw = primaryKeyword(query);
    // Jobicy requires a non-empty tag; a bare skills-less query falls back to
    // the title in primaryKeyword, so kw is empty only for a degenerate query
    // (which the UI gates the Search button on anyway).
    const url = `${ENDPOINT}?tag=${encodeURIComponent(kw)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${LABEL} responded ${res.status}`);
    const data = (await res.json()) as JobicyResponse;
    return (data.jobs ?? []).map(mapJob).filter((p) => p.title && p.url);
  },
};

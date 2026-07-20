// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Arbeitnow adapter — https://www.arbeitnow.com/api/job-board-api?search=<kw>
 *
 * Keyless, CORS-open (`access-control-allow-origin: *`, verified from a browser
 * origin). EU-heavy board (many Germany-based listings); a sample, not a
 * census. Postings arrive under a top-level `data` array with a UNIX
 * `created_at` timestamp.
 */

import type { JobProvider, JobPosting } from "../types.ts";
import type { JobQuery } from "../query-builder.ts";
import { htmlToPlaintext } from "../../jd-match/fetch-jd.ts";
import { searchPhrase } from "./keywords.ts";

const ENDPOINT = "https://www.arbeitnow.com/api/job-board-api";
const ID = "arbeitnow";
const LABEL = "Arbeitnow";

interface ArbeitnowJob {
  slug?: string;
  title?: string;
  company_name?: string;
  location?: string;
  url?: string;
  description?: string;
  created_at?: number;
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
}

function mapJob(job: ArbeitnowJob): JobPosting {
  return {
    id: `${ID}:${job.slug ?? job.url ?? ""}`,
    title: (job.title ?? "").trim(),
    company: (job.company_name ?? "").trim(),
    location: (job.location ?? "").trim(),
    url: job.url ?? "",
    description: htmlToPlaintext(job.description ?? ""),
    // Feed gives a UNIX seconds timestamp; normalize to ISO when present.
    postedAt:
      typeof job.created_at === "number"
        ? new Date(job.created_at * 1000).toISOString()
        : undefined,
    source: LABEL,
  };
}

export const arbeitnowProvider: JobProvider = {
  id: ID,
  label: LABEL,
  async search(query: JobQuery, signal: AbortSignal): Promise<JobPosting[]> {
    const kw = searchPhrase(query);
    const url = `${ENDPOINT}?search=${encodeURIComponent(kw)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${LABEL} responded ${res.status}`);
    const data = (await res.json()) as ArbeitnowResponse;
    return (data.data ?? []).map(mapJob).filter((p) => p.title && p.url);
  },
};

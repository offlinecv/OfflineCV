// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Remotive adapter — https://remotive.com/api/remote-jobs?search=<kw>
 *
 * Keyless, CORS-open (`access-control-allow-origin: *`, verified from a browser
 * origin). Remote-only feed skewed toward tech, so results are a sample, not a
 * census — the panel labels them as such.
 */

import type { JobProvider, JobPosting } from "../types.ts";
import type { JobQuery } from "../query-builder.ts";
import { htmlToPlaintext } from "../../jd-match/fetch-jd.ts";
import { searchPhrase } from "./keywords.ts";

const ENDPOINT = "https://remotive.com/api/remote-jobs";
const ID = "remotive";
const LABEL = "Remotive";

interface RemotiveJob {
  id?: number | string;
  title?: string;
  company_name?: string;
  candidate_required_location?: string;
  url?: string;
  description?: string;
  publication_date?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

function mapJob(job: RemotiveJob): JobPosting {
  return {
    // Fall back to the url (guaranteed non-empty by the post-map filter) so
    // two id-less postings never collide on `remotive:undefined` — the id
    // doubles as the React key and cross-provider dedup id.
    id: `${ID}:${job.id ?? job.url ?? ""}`,
    title: (job.title ?? "").trim(),
    company: (job.company_name ?? "").trim(),
    location: (job.candidate_required_location ?? "").trim(),
    url: job.url ?? "",
    description: htmlToPlaintext(job.description ?? ""),
    postedAt: job.publication_date,
    source: LABEL,
  };
}

export const remotiveProvider: JobProvider = {
  id: ID,
  label: LABEL,
  async search(query: JobQuery, signal: AbortSignal): Promise<JobPosting[]> {
    const kw = searchPhrase(query);
    const url = `${ENDPOINT}?search=${encodeURIComponent(kw)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${LABEL} responded ${res.status}`);
    const data = (await res.json()) as RemotiveResponse;
    return (data.jobs ?? []).map(mapJob).filter((p) => p.title && p.url);
  },
};

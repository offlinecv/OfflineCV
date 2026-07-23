// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import { remotiveProvider } from "./remotive.ts";
import type { JobQuery } from "../query-builder.ts";

const query: JobQuery = { titles: ["Backend Engineer"], skills: ["Go", "Python"] };

function mockFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remotiveProvider", () => {
  it("maps the feed shape to JobPosting and strips HTML from the description", async () => {
    mockFetch({
      jobs: [
        {
          id: 1185979,
          title: "Backend Engineer",
          company_name: "Acme",
          candidate_required_location: "Worldwide",
          url: "https://remotive.com/remote-jobs/backend-1185979",
          description: "<p>Build <strong>APIs</strong> in Go</p>",
          publication_date: "2026-07-04T16:53:04",
        },
      ],
    });

    const [job] = await remotiveProvider.search(query, new AbortController().signal);
    expect(job.id).toBe("remotive:1185979");
    expect(job.title).toBe("Backend Engineer");
    expect(job.company).toBe("Acme");
    expect(job.location).toBe("Worldwide");
    expect(job.source).toBe("Remotive");
    expect(job.description).not.toContain("<");
    expect(job.description).toContain("Build APIs in Go");
    expect(job.postedAt).toBe("2026-07-04T16:53:04");
  });

  it("sends the title as the search keyword and threads the abort signal", async () => {
    const fetchMock = mockFetch({ jobs: [] });
    const signal = new AbortController().signal;
    await remotiveProvider.search(query, signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("search=Backend%20Engineer");
    expect((init as RequestInit).signal).toBe(signal);
  });

  it("drops entries missing a title or url", async () => {
    mockFetch({
      jobs: [
        { id: 1, title: "", url: "https://x", description: "" },
        { id: 2, title: "Real Job", url: "", description: "" },
        { id: 3, title: "Keeper", company_name: "Co", url: "https://y", description: "" },
      ],
    });
    const jobs = await remotiveProvider.search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual(["remotive:3"]);
  });

  it("rejects on a non-ok response so the orchestrator can degrade it", async () => {
    mockFetch({}, false, 503);
    await expect(
      remotiveProvider.search(query, new AbortController().signal),
    ).rejects.toThrow(/Remotive responded 503/);
  });

  it("tolerates a missing jobs array", async () => {
    mockFetch({});
    await expect(
      remotiveProvider.search(query, new AbortController().signal),
    ).resolves.toEqual([]);
  });
});

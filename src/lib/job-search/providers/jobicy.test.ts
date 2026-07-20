// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import { jobicyProvider } from "./jobicy.ts";
import type { JobQuery } from "../query-builder.ts";

const query: JobQuery = { title: "Senior Software Engineer", skills: ["Kubernetes", "Go"] };

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

describe("jobicyProvider", () => {
  it("maps the camelCase jobs[] shape to JobPosting", async () => {
    mockFetch({
      jobs: [
        {
          id: 145290,
          jobTitle: "Senior Software Engineer",
          companyName: "Datadog",
          jobGeo: "France, Germany",
          url: "https://jobicy.com/jobs/145290",
          jobDescription: "<p>Own the <em>graph engine</em></p>",
          pubDate: "2026-07-05T12:10:02+00:00",
        },
      ],
    });

    const [job] = await jobicyProvider.search(query, new AbortController().signal);
    expect(job.id).toBe("jobicy:145290");
    expect(job.title).toBe("Senior Software Engineer");
    expect(job.company).toBe("Datadog");
    expect(job.source).toBe("Jobicy");
    expect(job.description).toBe("Own the graph engine");
    expect(job.postedAt).toBe("2026-07-05T12:10:02+00:00");
  });

  it("sends the first skill as the tag keyword (tag-style feed)", async () => {
    const fetchMock = mockFetch({ jobs: [] });
    await jobicyProvider.search(query, new AbortController().signal);
    expect(fetchMock.mock.calls[0][0]).toContain("tag=Kubernetes");
  });

  it("falls back to the title when there are no skills", async () => {
    const fetchMock = mockFetch({ jobs: [] });
    await jobicyProvider.search(
      { title: "Data Analyst", skills: [] },
      new AbortController().signal,
    );
    expect(fetchMock.mock.calls[0][0]).toContain("tag=Data%20Analyst");
  });

  it("rejects on a non-ok response", async () => {
    mockFetch({}, false, 429);
    await expect(
      jobicyProvider.search(query, new AbortController().signal),
    ).rejects.toThrow(/Jobicy responded 429/);
  });
});

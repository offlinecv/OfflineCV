// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAshbyProvider } from "./ashby.ts";
import type { JobQuery } from "../query-builder.ts";

const query: JobQuery = { title: "Backend Engineer", skills: ["Go", "Python"] };

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

describe("makeAshbyProvider", () => {
  it("maps the { jobs: [] } shape to JobPosting, preferring descriptionPlain", async () => {
    mockFetch({
      jobs: [
        {
          id: "uuid",
          title: "Staff Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/uuid",
          location: "San Francisco",
          department: "Engineering",
          descriptionPlain: "Plaintext description.",
          descriptionHtml: "<p>…</p>",
          publishedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const provider = makeAshbyProvider("acme", "Acme Inc");
    const [job] = await provider.search(query, new AbortController().signal);
    expect(job.id).toBe("ashby:acme:uuid");
    expect(job.title).toBe("Staff Engineer");
    expect(job.company).toBe("Acme Inc");
    expect(job.location).toBe("San Francisco");
    expect(job.url).toBe("https://jobs.ashbyhq.com/acme/uuid");
    expect(job.description).toBe("Plaintext description.");
    expect(job.postedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(job.departments).toEqual(["Engineering"]);
    expect(job.source).toBe("Acme Inc");
  });

  it("falls back to HTML-stripped descriptionHtml when descriptionPlain is absent", async () => {
    mockFetch({
      jobs: [
        {
          id: "1",
          title: "Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/1",
          descriptionHtml: "<p>Build &amp; ship <strong>APIs</strong></p>",
        },
      ],
    });
    const [job] = await makeAshbyProvider("acme").search(query, new AbortController().signal);
    expect(job.description).toBe("Build & ship APIs");
  });

  it("defaults the display name/label to the slug when no companyName is given", async () => {
    mockFetch({ jobs: [] });
    const provider = makeAshbyProvider("acme");
    expect(provider.id).toBe("ashby:acme");
    expect(provider.label).toBe("acme");
  });

  it("drops entries missing a title or url", async () => {
    mockFetch({
      jobs: [
        { id: "1", title: "", jobUrl: "https://x" },
        { id: "2", title: "Real Job", jobUrl: "" },
        { id: "3", title: "Keeper", jobUrl: "https://y" },
      ],
    });
    const jobs = await makeAshbyProvider("acme").search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual(["ashby:acme:3"]);
  });

  // The id doubles as the React key and the cross-provider dedup id, so two
  // id-less postings must not both key `ashby:acme:`.
  it("falls back to the url so id-less postings do not collide", async () => {
    mockFetch({
      jobs: [
        { title: "One", jobUrl: "https://x" },
        { title: "Two", jobUrl: "https://y" },
      ],
    });
    const jobs = await makeAshbyProvider("acme").search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual(["ashby:acme:https://x", "ashby:acme:https://y"]);
  });

  it("rejects on a non-ok response so the orchestrator can degrade it", async () => {
    mockFetch({}, false, 503);
    await expect(
      makeAshbyProvider("acme", "Acme Inc").search(query, new AbortController().signal),
    ).rejects.toThrow(/Acme Inc responded 503/);
  });

  it("tolerates a missing jobs array", async () => {
    mockFetch({});
    await expect(
      makeAshbyProvider("acme").search(query, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it("threads the abort signal and includes includeCompensation=false in the request URL", async () => {
    const fetchMock = mockFetch({ jobs: [] });
    const signal = new AbortController().signal;
    await makeAshbyProvider("acme").search(query, signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("includeCompensation=false");
    expect((init as RequestInit).signal).toBe(signal);
  });
});

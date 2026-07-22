// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import { makeGreenhouseProvider, hydrateGreenhouse } from "./greenhouse.ts";
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

describe("makeGreenhouseProvider", () => {
  it("maps the light index shape to JobPosting with an empty description", async () => {
    mockFetch({
      jobs: [
        {
          id: 4012345,
          title: "Senior Backend Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/4012345",
          location: { name: "Remote - US" },
          updated_at: "2026-07-01T12:00:00-04:00",
          departments: [{ name: "Engineering" }],
        },
      ],
    });

    const provider = makeGreenhouseProvider("acme", "Acme Inc");
    const [job] = await provider.search(query, new AbortController().signal);
    expect(job.id).toBe("greenhouse:acme:4012345");
    expect(job.title).toBe("Senior Backend Engineer");
    expect(job.company).toBe("Acme Inc");
    expect(job.location).toBe("Remote - US");
    expect(job.url).toBe("https://boards.greenhouse.io/acme/jobs/4012345");
    expect(job.postedAt).toBe("2026-07-01T12:00:00-04:00");
    expect(job.departments).toEqual(["Engineering"]);
    expect(job.description).toBe("");
    expect(job.source).toBe("Acme Inc");
  });

  it("defaults the display name/label to the slug when no companyName is given", async () => {
    mockFetch({ jobs: [] });
    const provider = makeGreenhouseProvider("acme");
    expect(provider.id).toBe("greenhouse:acme");
    expect(provider.label).toBe("acme");
  });

  it("produces unique ids across two different company slugs", async () => {
    mockFetch({
      jobs: [
        {
          id: 1,
          title: "Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
        },
      ],
    });
    const acme = await makeGreenhouseProvider("acme").search(
      query,
      new AbortController().signal,
    );

    mockFetch({
      jobs: [
        {
          id: 1,
          title: "Engineer",
          absolute_url: "https://boards.greenhouse.io/globex/jobs/1",
        },
      ],
    });
    const globex = await makeGreenhouseProvider("globex").search(
      query,
      new AbortController().signal,
    );

    expect(acme[0].id).toBe("greenhouse:acme:1");
    expect(globex[0].id).toBe("greenhouse:globex:1");
    expect(acme[0].id).not.toBe(globex[0].id);
  });

  it("drops entries missing a title or url", async () => {
    mockFetch({
      jobs: [
        { id: 1, title: "", absolute_url: "https://x" },
        { id: 2, title: "Real Job", absolute_url: "" },
        { id: 3, title: "Keeper", absolute_url: "https://y" },
      ],
    });
    const jobs = await makeGreenhouseProvider("acme").search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual(["greenhouse:acme:3"]);
  });

  // The id doubles as the React key and the cross-provider dedup id, so two
  // id-less postings must not both key `greenhouse:acme:`.
  it("falls back to the url so id-less postings do not collide", async () => {
    mockFetch({
      jobs: [
        { title: "One", absolute_url: "https://x" },
        { title: "Two", absolute_url: "https://y" },
      ],
    });
    const jobs = await makeGreenhouseProvider("acme").search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual([
      "greenhouse:acme:https://x",
      "greenhouse:acme:https://y",
    ]);
  });

  it("rejects on a non-ok response so the orchestrator can degrade it", async () => {
    mockFetch({}, false, 503);
    await expect(
      makeGreenhouseProvider("acme", "Acme Inc").search(query, new AbortController().signal),
    ).rejects.toThrow(/Acme Inc responded 503/);
  });

  it("tolerates a missing jobs array", async () => {
    mockFetch({});
    await expect(
      makeGreenhouseProvider("acme").search(query, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it("threads the abort signal into fetch", async () => {
    const fetchMock = mockFetch({ jobs: [] });
    const signal = new AbortController().signal;
    await makeGreenhouseProvider("acme").search(query, signal);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).signal).toBe(signal);
  });
});

describe("hydrateGreenhouse", () => {
  it("fetches /jobs/{id} and strips + unescapes content to plaintext", async () => {
    const fetchMock = mockFetch({
      id: 4012345,
      title: "Senior Backend Engineer",
      content: "<p>Build &amp; ship <strong>APIs</strong></p>",
    });

    const text = await hydrateGreenhouse("acme", "4012345", new AbortController().signal);
    expect(text).not.toContain("<");
    expect(text).not.toContain("&amp;");
    expect(text).toContain("Build & ship APIs");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects on a non-ok response", async () => {
    mockFetch({}, false, 404);
    await expect(
      hydrateGreenhouse("acme", "999", new AbortController().signal),
    ).rejects.toThrow(/Greenhouse job 999 responded 404/);
  });

  it("tolerates a missing content field", async () => {
    mockFetch({ id: 1, title: "Engineer" });
    await expect(hydrateGreenhouse("acme", "1", new AbortController().signal)).resolves.toBe("");
  });
});

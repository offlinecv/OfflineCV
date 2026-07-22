// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import { makeLeverProvider } from "./lever.ts";
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

describe("makeLeverProvider", () => {
  it("maps the top-level array shape to JobPosting, preferring descriptionPlain", async () => {
    mockFetch([
      {
        id: "abc-123-uuid",
        text: "Senior Frontend Engineer",
        hostedUrl: "https://jobs.lever.co/acme/abc-123-uuid",
        categories: { location: "Remote", team: "Engineering", commitment: "Full-time" },
        descriptionPlain: "Plaintext description already provided.",
        description: "<p>HTML description…</p>",
        createdAt: 1719763200000,
      },
    ]);

    const provider = makeLeverProvider("acme", "Acme Inc");
    const [job] = await provider.search(query, new AbortController().signal);
    expect(job.id).toBe("lever:acme:abc-123-uuid");
    expect(job.title).toBe("Senior Frontend Engineer");
    expect(job.company).toBe("Acme Inc");
    expect(job.location).toBe("Remote");
    expect(job.url).toBe("https://jobs.lever.co/acme/abc-123-uuid");
    expect(job.description).toBe("Plaintext description already provided.");
    expect(job.postedAt).toBe(new Date(1719763200000).toISOString());
    expect(job.departments).toEqual(["Engineering"]);
    expect(job.source).toBe("Acme Inc");
  });

  it("falls back to HTML-stripped description when descriptionPlain is absent", async () => {
    mockFetch([
      {
        id: "1",
        text: "Engineer",
        hostedUrl: "https://jobs.lever.co/acme/1",
        description: "<p>Build &amp; ship <strong>APIs</strong></p>",
      },
    ]);
    const [job] = await makeLeverProvider("acme").search(query, new AbortController().signal);
    expect(job.description).toBe("Build & ship APIs");
  });

  it("defaults the display name/label to the slug when no companyName is given", async () => {
    mockFetch([]);
    const provider = makeLeverProvider("acme");
    expect(provider.id).toBe("lever:acme");
    expect(provider.label).toBe("acme");
  });

  it("drops entries missing a title or url", async () => {
    mockFetch([
      { id: "1", text: "", hostedUrl: "https://x" },
      { id: "2", text: "Real Job", hostedUrl: "" },
      { id: "3", text: "Keeper", hostedUrl: "https://y" },
    ]);
    const jobs = await makeLeverProvider("acme").search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual(["lever:acme:3"]);
  });

  // The id doubles as the React key and the cross-provider dedup id, so two
  // id-less postings must not both key `lever:acme:`.
  it("falls back to the url so id-less postings do not collide", async () => {
    mockFetch([
      { text: "One", hostedUrl: "https://x" },
      { text: "Two", hostedUrl: "https://y" },
    ]);
    const jobs = await makeLeverProvider("acme").search(query, new AbortController().signal);
    expect(jobs.map((j) => j.id)).toEqual(["lever:acme:https://x", "lever:acme:https://y"]);
  });

  it("rejects on a non-ok response so the orchestrator can degrade it", async () => {
    mockFetch({}, false, 503);
    await expect(
      makeLeverProvider("acme", "Acme Inc").search(query, new AbortController().signal),
    ).rejects.toThrow(/Acme Inc responded 503/);
  });

  it("tolerates a null response", async () => {
    mockFetch(null);
    await expect(
      makeLeverProvider("acme").search(query, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  // A 200 carrying an object error envelope is the expected shape for a wrong
  // registry slug, and `?? []` does not guard it — `({}).map` is not a
  // function. Only `Array.isArray` does.
  it("tolerates a 200 whose body is an object, not an array", async () => {
    mockFetch({ error: "not found" });
    await expect(
      makeLeverProvider("acme").search(query, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it("threads the abort signal and includes ?limit= in the request URL", async () => {
    const fetchMock = mockFetch([]);
    const signal = new AbortController().signal;
    await makeLeverProvider("acme").search(query, signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("?mode=json&limit=");
    expect((init as RequestInit).signal).toBe(signal);
  });
});

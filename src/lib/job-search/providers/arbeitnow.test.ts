// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import { arbeitnowProvider } from "./arbeitnow.ts";
import type { JobQuery } from "../query-builder.ts";

const query: JobQuery = { title: "Frontend Engineer", skills: ["React"] };

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

describe("arbeitnowProvider", () => {
  it("maps the data[] shape and converts the unix created_at to ISO", async () => {
    mockFetch({
      data: [
        {
          slug: "frontend-berlin-289280",
          title: "Frontend Engineer",
          company_name: "Think3DDD",
          location: "Berlin",
          url: "https://www.arbeitnow.com/jobs/frontend-berlin-289280",
          description: "<p>React &amp; TypeScript</p>",
          created_at: 1783287031,
        },
      ],
    });

    const [job] = await arbeitnowProvider.search(query, new AbortController().signal);
    expect(job.id).toBe("arbeitnow:frontend-berlin-289280");
    expect(job.company).toBe("Think3DDD");
    expect(job.location).toBe("Berlin");
    expect(job.source).toBe("Arbeitnow");
    expect(job.description).toBe("React & TypeScript");
    expect(job.postedAt).toBe(new Date(1783287031 * 1000).toISOString());
  });

  it("sends the title as the search keyword", async () => {
    const fetchMock = mockFetch({ data: [] });
    await arbeitnowProvider.search(query, new AbortController().signal);
    expect(fetchMock.mock.calls[0][0]).toContain("search=Frontend%20Engineer");
  });

  it("rejects on a non-ok response", async () => {
    mockFetch({}, false, 500);
    await expect(
      arbeitnowProvider.search(query, new AbortController().signal),
    ).rejects.toThrow(/Arbeitnow responded 500/);
  });

  it("tolerates a missing data array", async () => {
    mockFetch({});
    await expect(
      arbeitnowProvider.search(query, new AbortController().signal),
    ).resolves.toEqual([]);
  });
});

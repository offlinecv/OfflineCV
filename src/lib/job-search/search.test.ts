// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobProvider, JobPosting } from "./types.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobQuery } from "./query-builder.ts";

// Mutable holder so each test can install its own provider set. rank.ts is NOT
// mocked — it runs the real jd-match coverage, exercising ranking parity.
const holder = vi.hoisted(() => ({ providers: [] as JobProvider[] }));

vi.mock("./providers/index.ts", () => ({
  getProviders: () => holder.providers,
}));

import { searchJobs } from "./search.ts";

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [],
  education: [],
};
const query: JobQuery = { title: "Frontend Engineer", skills: ["React"] };

function posting(overrides: Partial<JobPosting>): JobPosting {
  return {
    id: "x:1",
    title: "Frontend Engineer",
    company: "Acme",
    location: "Remote",
    url: "https://x/1",
    description: "We need React and TypeScript.",
    source: "Test",
    ...overrides,
  };
}

function provider(id: string, impl: JobProvider["search"]): JobProvider {
  return { id, label: id[0].toUpperCase() + id.slice(1), search: impl };
}

beforeEach(() => {
  holder.providers = [];
});

describe("searchJobs", () => {
  it("merges results across providers and dedups by normalized title+company", async () => {
    holder.providers = [
      provider("alpha", async () => [posting({ id: "alpha:1" })]),
      provider("beta", async () => [
        // Same title+company but different casing/spacing → deduped away.
        posting({ id: "beta:1", title: "  frontend   ENGINEER ", company: "acme" }),
        posting({ id: "beta:2", title: "Backend Engineer", company: "Other" }),
      ]),
    ];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    expect(res.degradedProviders).toEqual([]);
    expect(res.providerCount).toBe(2);
    const ids = res.jobs.map((j) => j.posting.id).sort();
    expect(ids).toEqual(["alpha:1", "beta:2"]);
  });

  it("degrades gracefully: one provider rejecting still yields the others' results", async () => {
    holder.providers = [
      provider("alpha", async () => [posting({ id: "alpha:1" })]),
      provider("beta", async () => {
        throw new Error("network down");
      }),
    ];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    expect(res.degradedProviders).toEqual(["Beta"]);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].posting.id).toBe("alpha:1");
  });

  it("flags a total failure when every provider rejects", async () => {
    holder.providers = [
      provider("alpha", async () => {
        throw new Error("boom");
      }),
      provider("beta", async () => {
        throw new Error("boom");
      }),
    ];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    expect(res.degradedProviders).toHaveLength(res.providerCount);
    expect(res.jobs).toEqual([]);
  });

  it("drops off-query postings client-side (feeds that ignore search= get filtered here)", async () => {
    holder.providers = [
      provider("alpha", async () => [
        // No query term in title or description → dropped before ranking.
        posting({
          id: "alpha:off",
          title: "Forklift Operator",
          description: "Operate warehouse machinery on the night shift.",
        }),
        // Title token match ("engineer" from "Frontend Engineer").
        posting({ id: "alpha:title", title: "Platform Engineer" }),
        // Skills-only match: no title-token hit, but the description mentions
        // a query SKILL — proves skill chips participate in the filter.
        posting({
          id: "alpha:skill",
          title: "UI Developer",
          description: "You will build React components all day.",
        }),
      ]),
    ];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    const ids = res.jobs.map((j) => j.posting.id).sort();
    expect(ids).toEqual(["alpha:skill", "alpha:title"]);
  });

  it("drops postings whose url is not http(s) — javascript: urls never render", async () => {
    holder.providers = [
      provider("alpha", async () => [
        posting({ id: "alpha:evil", url: "javascript:alert(document.cookie)" }),
        posting({
          id: "alpha:data",
          title: "Frontend Engineer II",
          url: "data:text/html,<script>1</script>",
        }),
        posting({ id: "alpha:ok", url: "https://example.com/job/1" }),
      ]),
    ];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    expect(res.jobs.map((j) => j.posting.id)).toEqual(["alpha:ok"]);
  });

  it("threads the abort signal into each provider", async () => {
    const signal = new AbortController().signal;
    const seen: AbortSignal[] = [];
    holder.providers = [
      provider("alpha", async (_q, s) => {
        seen.push(s);
        return [];
      }),
    ];
    await searchJobs(query, parsed, signal);
    expect(seen[0]).toBe(signal);
  });

  it("ranks the merged set and preserves card fit parity", async () => {
    holder.providers = [
      provider("alpha", async () => [
        // Both mention a query term ("frontend"/"React") so they clear the
        // client-side keyword filter; only strong covers the résumé skills.
        posting({ id: "alpha:weak", title: "A", description: "Frontend role. Rust and Kubernetes only." }),
        posting({ id: "alpha:strong", title: "B", description: "React and TypeScript expert." }),
      ]),
    ];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    expect(res.jobs[0].posting.id).toBe("alpha:strong");
    for (const job of res.jobs) {
      expect(job.score).toBe(job.jdMatch.coverage.score);
    }
  });
});

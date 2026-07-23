// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobProvider, JobPosting } from "./types.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobQuery } from "./query-builder.ts";

// Mutable holder so each test can install its own provider set. rank.ts is NOT
// mocked — it runs the real jd-match coverage, exercising ranking parity.
const holder = vi.hoisted(() => ({
  providers: [] as JobProvider[],
  /** Registry entries `searchJobs` asked the company-board tier to build. */
  boardEntriesSeen: [] as { name: string }[],
  boardTierCalls: 0,
}));

vi.mock("./providers/index.ts", () => ({
  // Mirrors the real signature: keyless set + whatever the caller passed.
  getProviders: (companyProviders: readonly JobProvider[] = []) => [
    ...holder.providers,
    ...companyProviders,
  ],
}));

vi.mock("./company-boards.ts", () => ({
  makeBoardProviders: (entries: { name: string }[]) => {
    holder.boardTierCalls += 1;
    holder.boardEntriesSeen = entries;
    return entries.map((entry) => ({
      id: `board:${entry.name}`,
      label: entry.name,
      search: async () => [],
    }));
  },
}));

import { searchJobs } from "./search.ts";
import type { CompanyEntry } from "./company-registry.ts";

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [],
  education: [],
};
const query: JobQuery = { titles: ["Frontend Engineer"], skills: ["React"] };

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
  holder.boardEntriesSeen = [];
  holder.boardTierCalls = 0;
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

  it("keeps postings matching ANY title token, not just the primary title (#539)", async () => {
    // A leadership résumé: primary title is an exec title, a prior title is an
    // IC/engineering-leadership one. Postings for the SECOND title must survive.
    const multiTitleQuery: JobQuery = {
      titles: ["Chief Technology Officer", "Backend Engineer"],
      skills: [],
    };
    holder.providers = [
      provider("alpha", async () => [
        // Matches only the non-primary title's token ("backend").
        posting({
          id: "alpha:secondary",
          title: "Backend Engineer",
          description: "Own our services.",
        }),
        // Matches the primary title's token ("technology").
        posting({
          id: "alpha:primary",
          title: "VP Technology",
          description: "Lead the org.",
        }),
        // Matches neither title → dropped.
        posting({
          id: "alpha:off",
          title: "Forklift Operator",
          description: "Night shift warehouse work.",
        }),
      ]),
    ];
    const res = await searchJobs(multiTitleQuery, parsed, new AbortController().signal);
    const ids = res.jobs.map((j) => j.posting.id).sort();
    expect(ids).toEqual(["alpha:primary", "alpha:secondary"]);
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

/**
 * The #533 wiring. The important case is the NEGATIVE one: a user who never
 * touches the company selector must get byte-for-byte the pre-#533 search,
 * including not paying for the company-board chunk at all.
 */
describe("searchJobs — company boards (#533)", () => {
  const stripe: CompanyEntry = {
    name: "Stripe",
    ats: "greenhouse",
    slug: "stripe",
    sectors: ["fintech"],
  };
  const vanta: CompanyEntry = {
    name: "Vanta",
    ats: "ashby",
    slug: "vanta",
    sectors: ["security"],
  };

  it("does not load the company-board tier when no companies are selected", async () => {
    holder.providers = [provider("alpha", async () => [posting({ id: "alpha:1" })])];

    const res = await searchJobs(query, parsed, new AbortController().signal);

    expect(holder.boardTierCalls).toBe(0);
    expect(res.providerCount).toBe(1);
  });

  it("defaults to keyless-only when the companies argument is omitted entirely", async () => {
    holder.providers = [provider("alpha", async () => [])];
    const res = await searchJobs(query, parsed, new AbortController().signal);
    expect(res.providerCount).toBe(holder.providers.length);
  });

  it("adds one provider per selected company, alongside the keyless feeds", async () => {
    holder.providers = [provider("alpha", async () => [posting({ id: "alpha:1" })])];

    const res = await searchJobs(
      query,
      parsed,
      new AbortController().signal,
      [stripe, vanta],
    );

    expect(holder.boardTierCalls).toBe(1);
    expect(holder.boardEntriesSeen).toEqual([stripe, vanta]);
    expect(res.providerCount).toBe(3);
    // The keyless result still comes through unchanged.
    expect(res.jobs.map((j) => j.posting.id)).toEqual(["alpha:1"]);
  });

  it("degrades a single failing board without sinking the rest of the fan-out", async () => {
    holder.providers = [
      provider("alpha", async () => [posting({ id: "alpha:1" })]),
      provider("beta", async () => {
        throw new Error("CORS blocked");
      }),
      provider("gamma", async () => [
        posting({ id: "gamma:1", title: "Backend Engineer", company: "G" }),
      ]),
    ];

    const res = await searchJobs(query, parsed, new AbortController().signal, [stripe]);

    expect(res.degradedProviders).toEqual(["Beta"]);
    expect(res.degradedProviders.length).toBeLessThan(res.providerCount);
    expect(res.jobs.map((j) => j.posting.id).sort()).toEqual(["alpha:1", "gamma:1"]);
  });

  it("keeps results in provider order when the fan-out exceeds the concurrency cap", async () => {
    // 12 providers > the limiter's 6, so this also exercises the second wave.
    holder.providers = Array.from({ length: 12 }, (_, i) =>
      provider(`p${i}`, async () => [
        posting({ id: `p${i}:1`, company: `Co${i}` }),
      ]),
    );

    const res = await searchJobs(query, parsed, new AbortController().signal);

    expect(res.providerCount).toBe(12);
    expect(res.jobs).toHaveLength(12);
    expect(res.degradedProviders).toEqual([]);
  });

  it("maps a rejected slot back to the right label under concurrency", async () => {
    // The failure sits past the first concurrency wave, so an index/order bug
    // in the limiter would name the wrong provider here.
    holder.providers = Array.from({ length: 10 }, (_, i) =>
      provider(`p${i}`, async () => {
        if (i === 8) throw new Error("down");
        return [posting({ id: `p${i}:1`, company: `Co${i}` })];
      }),
    );

    const res = await searchJobs(query, parsed, new AbortController().signal);

    expect(res.degradedProviders).toEqual(["P8"]);
  });
});

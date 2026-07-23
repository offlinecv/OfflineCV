// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The bounded-pipeline tests (#533) — the ones that actually defend the epic's
 * central claim: "a 1000-role board does not flood the browser".
 *
 * The assertion that carries that weight is the hydrate CALL COUNT. Filtering
 * and capping the results is easy to get right by accident; hydrating after
 * filtering is the part a refactor can silently invert, and the only way to
 * catch it is to count the description fetches against the board size rather
 * than inspecting the output.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { JobPosting } from "./types.ts";
import type { JobQuery } from "./query-builder.ts";
import type { CompanyEntry } from "./company-registry.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import { DB_NAME, closeDB } from "../storage/db.ts";

const hoisted = vi.hoisted(() => ({
  /** Light-index rows the fake board returns. */
  board: [] as JobPosting[],
  boardCalls: 0,
  hydrateCalls: [] as string[],
  /** Lever per-job hydrate ids, tracked separately from Greenhouse's. */
  leverHydrateCalls: [] as string[],
  /** When set, the fake board rejects with it — the CORS/404 case. */
  boardError: null as Error | null,
  /** Job ids whose description fetch should reject. */
  hydrateFailIds: new Set<string>(),
}));

// Stub the adapter layer, not `fetch`: this suite is about the ORDER of the
// pipeline stages, and the adapters have their own suites.
vi.mock("./providers/index.ts", () => ({
  makeCompanyProvider: (entry: CompanyEntry) => ({
    id: `${entry.ats}:${entry.slug}`,
    label: entry.name,
    search: async () => {
      hoisted.boardCalls += 1;
      if (hoisted.boardError) throw hoisted.boardError;
      return hoisted.board;
    },
  }),
}));

vi.mock("./providers/greenhouse.ts", () => ({
  hydrateGreenhouse: async (_slug: string, jobId: string) => {
    hoisted.hydrateCalls.push(jobId);
    if (hoisted.hydrateFailIds.has(jobId)) throw new Error("404");
    return `description for ${jobId}`;
  },
}));

vi.mock("./providers/lever.ts", () => ({
  hydrateLever: async (_slug: string, jobId: string) => {
    hoisted.leverHydrateCalls.push(jobId);
    return `lever description for ${jobId}`;
  },
}));

import {
  makeBoardProvider,
  makeBoardProviders,
  greenhouseJobId,
  leverJobId,
  hydrateDescriptions,
} from "./company-boards.ts";
import { DEFAULT_PER_COMPANY_CAP } from "./role-keywords.ts";
import { readCachedBoard } from "./board-cache.ts";

const STRIPE: CompanyEntry = {
  name: "Stripe",
  ats: "greenhouse",
  slug: "stripe",
  sectors: ["fintech"],
};
const query: JobQuery = { titles: ["Backend Engineer"], skills: [] };
const signal = new AbortController().signal;

/** A backend-titled resume, so `roleFilterForResume` yields a real (non-"all")
 *  filter rather than the permissive floor. */
const backendResume: HeuristicParsedResume = {
  skills: [],
  experience: [{ title: "Senior Backend Engineer", company: "X" }],
  education: [],
};

function ghPosting(n: number, title: string): JobPosting {
  return {
    id: `greenhouse:stripe:${n}`,
    title,
    company: "Stripe",
    location: "Remote",
    url: `https://boards.greenhouse.io/stripe/jobs/${n}`,
    description: "",
    source: "Stripe",
  };
}

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  hoisted.board = [];
  hoisted.boardCalls = 0;
  hoisted.hydrateCalls = [];
  hoisted.leverHydrateCalls = [];
  hoisted.boardError = null;
  hoisted.hydrateFailIds = new Set();
});

describe("greenhouseJobId", () => {
  it("strips the known prefix", () => {
    expect(greenhouseJobId("stripe", "greenhouse:stripe:12345")).toBe("12345");
  });

  it("returns '' for a posting from another provider", () => {
    expect(greenhouseJobId("stripe", "lever:stripe:abc")).toBe("");
  });

  it("is not fooled by a slug containing a colon-like segment", () => {
    // A trailing-colon search would return "b:9" here; prefix-stripping is exact.
    expect(greenhouseJobId("a:b", "greenhouse:a:b:9")).toBe("9");
  });
});

describe("leverJobId", () => {
  it("strips the known prefix", () => {
    expect(leverJobId("palantir", "lever:palantir:abc-123")).toBe("abc-123");
  });

  it("returns '' for a posting from another provider", () => {
    expect(leverJobId("palantir", "greenhouse:palantir:9")).toBe("");
  });

  it("is not fooled by a slug containing a colon-like segment", () => {
    expect(leverJobId("a:b", "lever:a:b:9")).toBe("9");
  });
});

describe("makeBoardProvider — filter and cap run BEFORE hydration", () => {
  it("hydrates once per survivor, not once per board row", async () => {
    // 500-row board: 3 backend roles, 497 unrelated.
    hoisted.board = [
      ghPosting(1, "Senior Backend Engineer"),
      ghPosting(2, "Staff Backend Engineer"),
      ghPosting(3, "Backend Engineer, Payments"),
      ...Array.from({ length: 497 }, (_, i) => ghPosting(100 + i, "Account Executive")),
    ];

    const [provider] = makeBoardProviders([STRIPE], backendResume);
    const results = await provider.search(query, signal);

    expect(results).toHaveLength(3);
    // The whole point: 3 description fetches for a 500-row board.
    expect(hoisted.hydrateCalls).toEqual(["1", "2", "3"]);
    expect(results.map((p) => p.description)).toEqual([
      "description for 1",
      "description for 2",
      "description for 3",
    ]);
  });

  it("caps per company, and hydrates only the capped set", async () => {
    // 40 rows that ALL match the role filter — only the cap can bound this.
    hoisted.board = Array.from({ length: 40 }, (_, i) =>
      ghPosting(i, "Backend Engineer"),
    );

    const [provider] = makeBoardProviders([STRIPE], backendResume);
    const results = await provider.search(query, signal);

    expect(results).toHaveLength(DEFAULT_PER_COMPANY_CAP);
    expect(hoisted.hydrateCalls).toHaveLength(DEFAULT_PER_COMPANY_CAP);
  });

  it("honours an explicit per-company cap", async () => {
    hoisted.board = Array.from({ length: 40 }, (_, i) =>
      ghPosting(i, "Backend Engineer"),
    );
    const provider = makeBoardProvider(
      STRIPE,
      { families: ["backend"], keywords: ["backend"], source: "heuristic" },
      2,
    );
    expect(await provider.search(query, signal)).toHaveLength(2);
    expect(hoisted.hydrateCalls).toHaveLength(2);
  });

  it("keeps a posting whose hydrate fails, minus its description", async () => {
    hoisted.board = [ghPosting(1, "Backend Engineer"), ghPosting(2, "Backend Engineer")];
    hoisted.hydrateFailIds = new Set(["1"]);

    const [provider] = makeBoardProviders([STRIPE], backendResume);
    const results = await provider.search(query, signal);

    expect(results).toHaveLength(2);
    expect(results[0].description).toBe("");
    expect(results[1].description).toBe("description for 2");
  });

  it("propagates a board failure so the orchestrator can degrade it", async () => {
    hoisted.boardError = new Error("CORS blocked");
    const [provider] = makeBoardProviders([STRIPE], backendResume);
    await expect(provider.search(query, signal)).rejects.toThrow("CORS blocked");
  });

  it("does not hydrate a FRESH Lever board — it already carries descriptionPlain", async () => {
    // On a cache MISS the board fetch returns descriptions inline, so a Lever
    // survivor whose text is already present costs zero per-job requests.
    const lever: CompanyEntry = {
      name: "Palantir",
      ats: "lever",
      slug: "palantir",
      sectors: ["government-defense"],
    };
    hoisted.board = [
      {
        ...ghPosting(1, "Backend Engineer"),
        id: "lever:palantir:1",
        company: "Palantir",
        description: "already plaintext",
      },
    ];
    const [provider] = makeBoardProviders([lever], backendResume);
    const results = await provider.search(query, signal);
    expect(hoisted.leverHydrateCalls).toEqual([]);
    expect(hoisted.hydrateCalls).toEqual([]);
    expect(results[0].description).toBe("already plaintext");
  });

  it("passes the whole (capped) board through for an unclassifiable resume", async () => {
    // The never-fail-closed floor: an empty resume must not yield zero jobs.
    hoisted.board = [ghPosting(1, "Chef"), ghPosting(2, "Welder")];
    const [provider] = makeBoardProviders([STRIPE], {
      skills: [],
      experience: [],
      education: [],
    });
    expect(await provider.search(query, signal)).toHaveLength(2);
  });
});

describe("makeBoardProvider — IndexedDB cache", () => {
  it("does not re-fetch a board that is cached within the TTL", async () => {
    hoisted.board = [ghPosting(1, "Backend Engineer")];
    const [provider] = makeBoardProviders([STRIPE], backendResume);

    await provider.search(query, signal);
    expect(hoisted.boardCalls).toBe(1);

    await provider.search(query, signal);
    expect(hoisted.boardCalls).toBe(1);
  });

  it("caches the LIGHT index, so a cache hit still hydrates", async () => {
    hoisted.board = [ghPosting(1, "Backend Engineer")];
    const [provider] = makeBoardProviders([STRIPE], backendResume);

    await provider.search(query, signal);
    hoisted.hydrateCalls = [];

    const results = await provider.search(query, signal);
    expect(hoisted.hydrateCalls).toEqual(["1"]);
    expect(results[0].description).toBe("description for 1");
  });

  it("re-hydrates Lever survivors from the stripped cache — once per survivor, not board size", async () => {
    const PALANTIR: CompanyEntry = {
      name: "Palantir",
      ats: "lever",
      slug: "palantir",
      sectors: ["government-defense"],
    };
    // 2 backend roles that survive the filter + 50 unrelated that don't.
    const lv = (n: number, title: string, desc: string): JobPosting => ({
      ...ghPosting(n, title),
      id: `lever:palantir:${n}`,
      company: "Palantir",
      description: desc,
    });
    hoisted.board = [
      lv(1, "Senior Backend Engineer", "fresh plaintext 1"),
      lv(2, "Backend Engineer", "fresh plaintext 2"),
      ...Array.from({ length: 50 }, (_, i) => lv(100 + i, "Account Executive", "x")),
    ];
    const [provider] = makeBoardProviders([PALANTIR], backendResume);

    // Cache miss: descriptions arrive inline, so nothing is hydrated per-job.
    const first = await provider.search(query, signal);
    expect(hoisted.boardCalls).toBe(1);
    expect(hoisted.leverHydrateCalls).toEqual([]);
    expect(first.map((p) => p.description)).toEqual(["fresh plaintext 1", "fresh plaintext 2"]);

    // Cache hit: the cache stored the LIGHT index (descriptions stripped), so
    // each survivor is hydrated per-job — count == survivors (2), never the
    // 52-row board size.
    hoisted.leverHydrateCalls = [];
    const second = await provider.search(query, signal);
    expect(hoisted.boardCalls).toBe(1); // no re-fetch
    expect(hoisted.leverHydrateCalls).toEqual(["1", "2"]);
    expect(second.map((p) => p.description)).toEqual([
      "lever description for 1",
      "lever description for 2",
    ]);
  });

  it("never caches Ashby — it re-fetches fresh, descriptions intact, no hydrate", async () => {
    const RAMP: CompanyEntry = {
      name: "Ramp",
      ats: "ashby",
      slug: "ramp",
      sectors: ["fintech"],
    };
    hoisted.board = [
      {
        ...ghPosting(1, "Backend Engineer"),
        id: "ashby:ramp:1",
        company: "Ramp",
        description: "ashby plaintext",
      },
    ];
    const [provider] = makeBoardProviders([RAMP], backendResume);

    const first = await provider.search(query, signal);
    expect(first[0].description).toBe("ashby plaintext");
    expect(hoisted.boardCalls).toBe(1);

    // No cache was written, so the second search re-fetches the whole board.
    const second = await provider.search(query, signal);
    expect(hoisted.boardCalls).toBe(2);
    expect(second[0].description).toBe("ashby plaintext");
    expect(hoisted.hydrateCalls).toEqual([]);
    expect(hoisted.leverHydrateCalls).toEqual([]);
    // Nothing landed in the cache under the Ashby key.
    expect(await readCachedBoard("ashby", "ramp")).toBeNull();
  });

  it("fetches when the cache read throws — a cache error never sinks a search", async () => {
    hoisted.board = [ghPosting(1, "Backend Engineer")];
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open() {
          throw new Error("storage disabled");
        },
      },
    });
    await closeDB();
    try {
      const [provider] = makeBoardProviders([STRIPE], backendResume);
      expect(await provider.search(query, signal)).toHaveLength(1);
      expect(hoisted.boardCalls).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: original,
      });
      await closeDB();
    }
  });
});

describe("hydrateDescriptions", () => {
  it("returns non-Greenhouse postings untouched without any fetch", async () => {
    const postings = [
      { ...ghPosting(1, "X"), id: "ashby:vanta:1", description: "plain" },
    ];
    const result = await hydrateDescriptions(
      { name: "Vanta", ats: "ashby", slug: "vanta", sectors: ["security"] },
      postings,
      signal,
    );
    expect(result).toEqual(postings);
    expect(hoisted.hydrateCalls).toEqual([]);
  });

  it("skips a posting whose id doesn't carry a recoverable job id", async () => {
    const postings = [{ ...ghPosting(1, "X"), id: "greenhouse:stripe:" }];
    const result = await hydrateDescriptions(STRIPE, postings, signal);
    expect(hoisted.hydrateCalls).toEqual([]);
    expect(result[0].description).toBe("");
  });
});

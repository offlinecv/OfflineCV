// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The asymmetric company selector. What matters is the asymmetry itself:
 * removing a company must NOT refetch, and adding one must fetch exactly the
 * added board — not the whole fan-out — and only when asked.
 *
 * `searchJobs`/`searchCompanyBoards` are mocked; `refineSearchResult` is the real
 * module, so the ranked counts asserted here come from the same pipeline the app
 * runs.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJobSearch } from "./useJobSearch.ts";
import type { CompanyEntry } from "../lib/job-search/company-registry.ts";
import type { JobPosting } from "../lib/job-search/types.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { JobQuery } from "../lib/job-search/query-builder.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function posting(id: string, title: string, company: string): JobPosting {
  return {
    id,
    title,
    company,
    location: "Remote",
    url: "https://example.com/job",
    description: `${title} — build and operate services.`,
    source: company,
  };
}

const FEED_JOB = posting("remotive:1", "Platform Engineer", "Globex");
const ACME_JOB = posting("greenhouse:acme:9", "Platform Engineer", "Acme");
const RAMP_JOB = posting("lever:ramp:4", "Platform Engineer", "Ramp");

const searchJobs = vi.fn();
const searchCompanyBoards = vi.fn();

vi.mock("../lib/job-search/search.ts", () => ({
  searchJobs: (...args: unknown[]) => searchJobs(...args),
  searchCompanyBoards: (...args: unknown[]) => searchCompanyBoards(...args),
}));

const ACME: CompanyEntry = {
  name: "Acme",
  ats: "greenhouse",
  slug: "acme",
  sectors: ["fintech"],
};
const RAMP: CompanyEntry = {
  name: "Ramp",
  ats: "lever",
  slug: "ramp",
  sectors: ["fintech"],
};

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  skills: ["kubernetes", "go"],
  experience: [{ company: "Initech", title: "Platform Engineer" }],
  education: [],
};
const query: JobQuery = { titles: ["Platform Engineer"], skills: ["go"] };

type Hook = ReturnType<typeof useJobSearch>;
let latest: Hook;

/** The journey's Match-stage mark site (#826), spied on per test. */
let onSearchLoaded = vi.fn();

function Harness({ companies }: { companies: readonly CompanyEntry[] }) {
  latest = useJobSearch(query, parsed, companies, onSearchLoaded);
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function render(companies: readonly CompanyEntry[]) {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness, { companies }));
  });
}

async function rerender(companies: readonly CompanyEntry[]) {
  await act(async () => {
    root.render(createElement(Harness, { companies }));
  });
  await flush();
}

/**
 * Let the re-rank settle. `refineSearchResult` dynamic-imports `rank.ts`, so the
 * chain is `setPhase` behind a module resolution behind a promise — a microtask
 * flush alone leaves the pre-re-rank phase in place, which reads as "the effect
 * never ran" rather than as a timing miss. Several macrotasks because the FIRST
 * test to reach the real `rank.ts` pays an uncached resolution that later ones
 * don't; without this the suite passes or fails by test order.
 */
async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// `refineSearchResult` reaches the ranking tier through a dynamic import, and
// the FIRST resolution costs real transform time — more than any bounded tick
// loop will wait. Warming the module here makes every in-test import a cache
// hit, so `flush()` only has to drain promises. Without it the suite passes or
// fails by test order: whichever test paid the cold import loses.
beforeAll(async () => {
  await import("../lib/job-search/rank.ts");
});

beforeEach(() => {
  onSearchLoaded = vi.fn();
  searchJobs.mockReset();
  searchCompanyBoards.mockReset();
  searchJobs.mockResolvedValue({
    // The mock stands in for the real fan-out, so its `jobs` are the ranked
    // form of its own `rawPostings` — only `.posting` is read here.
    jobs: [{ posting: FEED_JOB }, { posting: ACME_JOB }],
    degradedProviders: [],
    providerCount: 4,
    excludeSuppressed: false,
    roleSuppressed: false,
    rawPostings: [FEED_JOB, ACME_JOB],
  });
  searchCompanyBoards.mockResolvedValue({
    postings: [RAMP_JOB],
    degradedProviders: [],
    providerCount: 1,
  });
});

afterEach(() => {
  act(() => root?.unmount());
});

function loadedCompanies(): string[] {
  if (latest.phase.kind !== "loaded") throw new Error("not loaded");
  return latest.phase.result.jobs.map((job) => job.posting.company);
}

describe("useJobSearch — company selection", () => {
  it("ranks the fetched snapshot and reports nothing pending", async () => {
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    expect(loadedCompanies()).toEqual(expect.arrayContaining(["Globex", "Acme"]));
    expect(latest.pendingCompanies).toEqual([]);
  });

  it("reports a SEARCH, not every landing on `loaded` (#826)", async () => {
    // The journey milestone is "you searched", once. The company merge and
    // both local re-ranks also set `loaded`, and counting them would re-mark
    // the stage on every chip toggle for a search the user ran minutes ago.
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    expect(onSearchLoaded).toHaveBeenCalledTimes(1);

    await rerender([]);
    await flush();
    expect(onSearchLoaded).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the search itself fails", async () => {
    searchJobs.mockRejectedValueOnce(new Error("every provider down"));
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    expect(latest.phase.kind).toBe("failed");
    expect(onSearchLoaded).not.toHaveBeenCalled();
  });

  it("drops a deselected company's postings WITHOUT refetching", async () => {
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    expect(searchJobs).toHaveBeenCalledTimes(1);

    await rerender([]);
    expect(loadedCompanies()).toEqual(["Globex"]);
    // The whole point: local set arithmetic, no network.
    expect(searchJobs).toHaveBeenCalledTimes(1);
    expect(searchCompanyBoards).not.toHaveBeenCalled();
  });

  it("reports a newly selected company as pending and does not fetch it yet", async () => {
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();

    await rerender([ACME, RAMP]);
    expect(latest.pendingCompanies.map((c) => c.name)).toEqual(["Ramp"]);
    // A checkbox is not a Search click.
    expect(searchCompanyBoards).not.toHaveBeenCalled();
    expect(loadedCompanies()).not.toContain("Ramp");
  });

  it("fetches ONLY the pending board on request and merges it in", async () => {
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    await rerender([ACME, RAMP]);

    await act(async () => latest.searchPendingCompanies());
    await flush();

    expect(searchCompanyBoards).toHaveBeenCalledTimes(1);
    // Fourth argument is the company list — just the addition, not the selection.
    expect(searchCompanyBoards.mock.calls[0][3]).toEqual([RAMP]);
    // Still one full search: the keyless feeds were never refetched.
    expect(searchJobs).toHaveBeenCalledTimes(1);
    expect(loadedCompanies()).toContain("Ramp");
    expect(latest.pendingCompanies).toEqual([]);
  });

  it("keeps the existing results when the incremental fetch fails", async () => {
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    await rerender([ACME, RAMP]);
    searchCompanyBoards.mockRejectedValue(new Error("board down"));

    await act(async () => latest.searchPendingCompanies());
    await flush();

    expect(loadedCompanies()).toEqual(expect.arrayContaining(["Globex", "Acme"]));
    expect(latest.isUpdating).toBe(false);
  });

  it("re-adding a deselected company needs a fetch, since its postings are gone", async () => {
    await render([ACME]);
    await act(async () => latest.runSearch());
    await flush();
    await rerender([]);
    expect(loadedCompanies()).toEqual(["Globex"]);

    await rerender([ACME]);
    expect(latest.pendingCompanies.map((c) => c.name)).toEqual(["Acme"]);
  });
});

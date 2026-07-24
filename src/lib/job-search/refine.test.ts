// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { refineSearchResult } from "./refine.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobPosting } from "./types.ts";
import type { JobQuery } from "./query-builder.ts";

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [],
  education: [],
};

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

const query: JobQuery = { titles: ["Frontend Engineer"], skills: ["React"] };

describe("refineSearchResult (issue 568)", () => {
  it("is the identity pipeline when the query asserts no refinement knobs", async () => {
    const raw = [posting({ id: "a" }), posting({ id: "b", title: "Backend Engineer" })];
    const result = await refineSearchResult(raw, parsed, query, [], 1);
    expect(result.jobs.map((j) => j.posting.id).sort()).toEqual(["a", "b"]);
    expect(result.excludeSuppressed).toBe(false);
    expect(result.rawPostings.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("narrows by query.families when asserted", async () => {
    const raw = [
      posting({ id: "fe", title: "Frontend Engineer" }),
      posting({ id: "designer", title: "Product Designer" }),
    ];
    const result = await refineSearchResult(
      raw,
      parsed,
      { ...query, families: ["frontend"] },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id)).toEqual(["fe"]);
  });

  it("never fails closed: an empty families list keeps every posting", async () => {
    const raw = [
      posting({ id: "fe", title: "Frontend Engineer" }),
      posting({ id: "designer", title: "Product Designer" }),
    ];
    const result = await refineSearchResult(raw, parsed, { ...query, families: [] }, [], 1);
    expect(result.jobs.map((j) => j.posting.id).sort()).toEqual(["designer", "fe"]);
    expect(result.roleSuppressed).toBe(false);
  });

  it("never fails closed: a non-empty family matching no posting title keeps them all and flags roleSuppressed (issue 566)", async () => {
    // Generically-titled postings that pass matchesQuery on skills/description
    // but match no narrow role-title keyword — the all-generic keyless-feed
    // regression. Role filtering must be skipped, not empty the panel.
    const raw = [
      posting({ id: "a", title: "Software Engineer" }),
      posting({ id: "b", title: "Senior Developer" }),
    ];
    const result = await refineSearchResult(
      raw,
      parsed,
      { ...query, families: ["frontend"] },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id).sort()).toEqual(["a", "b"]);
    expect(result.roleSuppressed).toBe(true);
  });

  it("does not flag roleSuppressed on a genuinely empty input", async () => {
    const result = await refineSearchResult([], parsed, { ...query, families: ["frontend"] }, [], 1);
    expect(result.jobs).toEqual([]);
    expect(result.roleSuppressed).toBe(false);
  });

  it("still applies exclude terms and ranking on top of the role-family filter", async () => {
    const raw = [
      posting({ id: "kept", title: "Frontend Engineer" }),
      posting({ id: "excluded", title: "Frontend Engineer (Solutions Architect)" }),
    ];
    const result = await refineSearchResult(
      raw,
      parsed,
      { ...query, families: ["frontend"], excludeTerms: ["solutions architect"] },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id)).toEqual(["kept"]);
  });

  it("passes through the degradedProviders/providerCount it was given", async () => {
    const result = await refineSearchResult([], parsed, query, ["Beta"], 2);
    expect(result.degradedProviders).toEqual(["Beta"]);
    expect(result.providerCount).toBe(2);
  });
});

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

describe("refineSearchResult — local-only (issue 809)", () => {
  const raw = [
    posting({ id: "local", title: "Frontend Engineer", location: "Austin, TX, USA" }),
    posting({ id: "far", title: "Frontend Engineer", location: "Seattle, WA" }),
    posting({ id: "remote", title: "Frontend Engineer", location: "Remote" }),
  ];

  it("changes nothing while the toggle is off — location stays a soft axis", async () => {
    const result = await refineSearchResult(
      raw,
      parsed,
      { ...query, location: "Austin, TX" },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id).sort()).toEqual([
      "far",
      "local",
      "remote",
    ]);
    expect(result.locationSuppressed).toBe(false);
    expect(result.locationFilteredOut).toBe(0);
  });

  it("drops non-local postings once the user turns it on, keeping remote", async () => {
    const result = await refineSearchResult(
      raw,
      parsed,
      { ...query, location: "Austin, TX", locationOnly: true },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id).sort()).toEqual(["local", "remote"]);
    expect(result.locationFilteredOut).toBe(1);
    expect(result.locationSuppressed).toBe(false);
  });

  it("is inert with no location set, however the toggle reads", async () => {
    const result = await refineSearchResult(
      raw,
      parsed,
      { ...query, locationOnly: true },
      [],
      1,
    );
    expect(result.jobs).toHaveLength(3);
    expect(result.locationFilteredOut).toBe(0);
  });

  it("never fails closed: a set it would empty is kept whole and flagged", async () => {
    const elsewhere = [
      posting({ id: "far", location: "Seattle, WA" }),
      posting({ id: "further", location: "Portland, ME" }),
    ];
    const result = await refineSearchResult(
      elsewhere,
      parsed,
      { ...query, location: "Austin, TX", locationOnly: true },
      [],
      1,
    );
    expect(result.jobs).toHaveLength(2);
    expect(result.locationSuppressed).toBe(true);
    expect(result.locationFilteredOut).toBe(0);
  });

  it("does not count a posting whose feed stated no location as hidden (#905 review)", async () => {
    const mixed = [
      posting({ id: "local", location: "Austin, TX" }),
      posting({ id: "far", location: "Seattle, WA" }),
      posting({ id: "unstated", location: "" }),
    ];
    const result = await refineSearchResult(
      mixed,
      parsed,
      { ...query, location: "Austin, TX", locationOnly: true },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id).sort()).toEqual(["local", "unstated"]);
    expect(result.locationFilteredOut).toBe(1);
    expect(result.locationSuppressed).toBe(false);
  });

  it("counts only what IT removed, not what the exclude filter already took", async () => {
    const mixed = [
      posting({ id: "local", location: "Austin, TX" }),
      posting({ id: "far", location: "Seattle, WA" }),
      posting({ id: "excluded", title: "Sales Engineer", location: "Austin, TX" }),
    ];
    const result = await refineSearchResult(
      mixed,
      parsed,
      {
        ...query,
        location: "Austin, TX",
        locationOnly: true,
        excludeTerms: ["Sales"],
      },
      [],
      1,
    );
    expect(result.jobs.map((j) => j.posting.id)).toEqual(["local"]);
    expect(result.locationFilteredOut).toBe(1);
  });

  it("still egresses nothing — the filter is a pure local set operation", async () => {
    const before = raw.map((p) => ({ ...p }));
    await refineSearchResult(
      raw,
      parsed,
      { ...query, location: "Austin, TX", locationOnly: true },
      [],
      1,
    );
    expect(raw).toEqual(before);
  });
});

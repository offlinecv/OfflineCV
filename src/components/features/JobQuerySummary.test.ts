// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `summarizeQuery` is what the user reads once `/jobs/` folds the search form
 * away, so the assertions here are about it not LYING: a filter that is doing
 * work must appear, and one that is not must not.
 */

import { describe, it, expect } from "vitest";
import { summarizeQuery } from "./JobQuerySummary.tsx";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";

const base: JobQuery = { titles: [], skills: [] };

describe("summarizeQuery", () => {
  it("names the titles, location and company count", () => {
    expect(
      summarizeQuery(
        { ...base, titles: ["Staff Engineer", "Principal Engineer"], location: "Austin, TX" },
        9,
      ),
    ).toEqual(["Staff Engineer / Principal Engineer", "Austin, TX", "9 companies"]);
  });

  it("says 'anywhere' rather than omitting an unset location", () => {
    // A location-blind search is the one silent axis a user reads as a bug, so
    // it is the one default that still gets a segment.
    expect(summarizeQuery({ ...base, titles: ["Designer"] }, 0)).toEqual([
      "Designer",
      "anywhere",
      "0 companies",
    ]);
  });

  it("omits the filters that are not filtering", () => {
    const summary = summarizeQuery({ ...base, titles: ["Designer"] }, 1);
    expect(summary.join(" · ")).not.toMatch(/excluded|\$|skill/);
    // Singular company, not "1 companies".
    expect(summary).toContain("1 company");
  });

  it("counts skills and exclusions and rounds the comp floor to $k", () => {
    expect(
      summarizeQuery(
        {
          titles: ["SRE"],
          skills: ["go", "k8s", "terraform"],
          excludeTerms: ["sales"],
          seniority: "senior",
          compFloor: 185_000,
          location: "Remote",
        },
        4,
      ),
    ).toEqual([
      "SRE",
      "Remote",
      "senior",
      "3 skills",
      "1 excluded",
      "≥ $185k",
      "4 companies",
    ]);
  });

  it("does not report a location that is only whitespace", () => {
    expect(summarizeQuery({ ...base, titles: ["PM"], location: "   " }, 2)).toContain(
      "anywhere",
    );
  });
});

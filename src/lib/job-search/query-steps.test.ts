// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Coverage for the step rail's summaries (#602). A summary is the ONLY readout
 * of a step whose panel is closed, so the property under test is that it states
 * what the user has already set and nothing else — every assertion here is
 * about a claim a user could check by opening the step.
 *
 * The review summary is the sharp one: it must quote what actually egresses,
 * which means it is asserted against `searchPhrase`'s own output rather than a
 * hardcoded string. A test that hardcoded the phrase would keep passing if the
 * summary drifted away from the egress helper, which is the exact failure the
 * module exists to prevent.
 */

import { describe, expect, it } from "vitest";
import { describeQuerySteps } from "./query-steps.ts";
import { searchPhrase } from "./providers/keywords.ts";
import type { JobQuery } from "./query-builder.ts";

const summaryOf = (query: JobQuery, id: string, companyCount = 0) =>
  describeQuerySteps(query, companyCount).find((s) => s.id === id)!.summary;

describe("describeQuerySteps", () => {
  it("returns the four steps in the order of the work", () => {
    const steps = describeQuerySteps({ titles: [], skills: [] }, 0);
    expect(steps.map((s) => s.id)).toEqual(["role", "skills", "filters", "review"]);
  });

  it("counts titles and skills, singular and plural", () => {
    expect(summaryOf({ titles: ["Staff Engineer"], skills: [] }, "role")).toContain(
      "1 title",
    );
    expect(
      summaryOf({ titles: ["Staff Engineer", "Tech Lead"], skills: [] }, "role"),
    ).toContain("2 titles");
    expect(summaryOf({ titles: [], skills: ["Rust"] }, "skills")).toContain("1 skill");
    expect(summaryOf({ titles: [], skills: ["Rust", "Go"] }, "skills")).toContain(
      "2 skills",
    );
  });

  it("says what is absent rather than showing a zero", () => {
    const empty: JobQuery = { titles: [], skills: [] };
    expect(summaryOf(empty, "role")).toBe("No title yet");
    expect(summaryOf(empty, "skills")).toBe("No skills yet");
    expect(summaryOf(empty, "filters")).toBe("Anywhere, nothing ruled out");
    expect(summaryOf(empty, "review")).toBe("Nothing to search for yet");
    for (const step of describeQuerySteps(empty, 0)) {
      expect(step.summary).not.toMatch(/\b0\b/);
    }
  });

  it("names the target level alongside the title count, only when one is set", () => {
    const titles = ["Staff Engineer"];
    expect(summaryOf({ titles, skills: [], seniority: "Staff" }, "role")).toContain(
      "Staff",
    );
    expect(summaryOf({ titles, skills: [] }, "role")).not.toContain("Staff ·");
  });

  it("assembles the filters summary from only the axes that are set", () => {
    const query: JobQuery = {
      titles: [],
      skills: [],
      location: "Austin, TX",
      excludeTerms: ["Recruiter", "Sales Engineer"],
      compFloor: 180_000,
    };
    const summary = summaryOf(query, "filters", 3);
    expect(summary).toContain("Austin, TX");
    expect(summary).toContain("2 excluded");
    expect(summary).toContain("$180,000");
    expect(summary).toContain("3 company boards");

    // A query with only a location says only the location — no empty segments,
    // no "0 excluded".
    expect(summaryOf({ titles: [], skills: [], location: "Remote" }, "filters")).toBe(
      "Remote",
    );
  });

  it("quotes the review step from the egress helper itself, not a copy", () => {
    const query: JobQuery = {
      titles: ["Founder & CEO", "Engineering Lead"],
      skills: ["Kubernetes"],
    };
    const phrase = searchPhrase(query);
    expect(phrase.length).toBeGreaterThan(0);
    expect(summaryOf(query, "review")).toContain(phrase);
  });

  it("follows a promotion, because it reads the same list order the feeds do", () => {
    const before: JobQuery = { titles: ["Founder & CEO", "Engineering Lead"], skills: [] };
    const after: JobQuery = { titles: ["Engineering Lead", "Founder & CEO"], skills: [] };
    expect(summaryOf(before, "review")).toContain(searchPhrase(before));
    expect(summaryOf(after, "review")).toContain(searchPhrase(after));
    expect(summaryOf(before, "review")).not.toBe(summaryOf(after, "review"));
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { buildDeepLinks, MAX_DEEP_LINK_SKILLS } from "./deep-links.ts";
import type { JobQuery } from "./query-builder.ts";

function query(overrides: Partial<JobQuery> = {}): JobQuery {
  return { titles: [], skills: [], ...overrides };
}

describe("buildDeepLinks", () => {
  it("returns one link each for LinkedIn, Indeed, and Google Jobs", () => {
    const links = buildDeepLinks(query({ titles: ["Software Engineer"] }));
    expect(links.map((l) => l.label)).toEqual(["LinkedIn", "Indeed", "Google Jobs"]);
    for (const link of links) {
      expect(() => new URL(link.url)).not.toThrow();
    }
  });

  it("prefills keywords from seniority + title + skills, space-joined", () => {
    const links = buildDeepLinks(
      query({ titles: ["Backend Engineer"], seniority: "Senior", skills: ["python", "go"] }),
    );
    const linkedin = new URL(links[0].url);
    expect(linkedin.searchParams.get("keywords")).toBe(
      "Senior Backend Engineer python go",
    );
    const indeed = new URL(links[1].url);
    expect(indeed.searchParams.get("q")).toBe("Senior Backend Engineer python go");
  });

  it("includes EVERY title in the keyword phrase, most-recent-first (#539)", () => {
    const links = buildDeepLinks(
      query({
        titles: ["VP Engineering", "Engineering Manager", "Staff Engineer"],
        skills: ["go"],
      }),
    );
    const linkedin = new URL(links[0].url);
    expect(linkedin.searchParams.get("keywords")).toBe(
      "VP Engineering Engineering Manager Staff Engineer go",
    );
  });

  it("skips seniority when ANY title already contains it (no 'Senior Senior …')", () => {
    const links = buildDeepLinks(
      query({ titles: ["Senior Backend Engineer"], seniority: "Senior", skills: ["go"] }),
    );
    const linkedin = new URL(links[0].url);
    expect(linkedin.searchParams.get("keywords")).toBe("Senior Backend Engineer go");
  });

  it("prepends seniority when no title carries it (user-typed seniority)", () => {
    const links = buildDeepLinks(
      query({ titles: ["Backend Engineer", "Platform Engineer"], seniority: "Staff" }),
    );
    const linkedin = new URL(links[0].url);
    expect(linkedin.searchParams.get("keywords")).toBe(
      "Staff Backend Engineer Platform Engineer",
    );
  });

  it("URL-encodes special characters in title/skills", () => {
    const links = buildDeepLinks(
      query({ titles: ["C++ Engineer & Architect"], skills: ["c#", "R&D"] }),
    );
    const linkedin = new URL(links[0].url);
    // Round-trips through URLSearchParams decoding back to the original string.
    expect(linkedin.searchParams.get("keywords")).toBe("C++ Engineer & Architect c# R&D");
    // The raw query string must actually be percent/plus-encoded, not literal.
    expect(links[0].url).not.toContain("C++ Engineer & Architect");
    expect(links[0].url).toMatch(/keywords=/);
  });

  it("Google Jobs appends the word 'jobs' to the keyword string", () => {
    const links = buildDeepLinks(query({ titles: ["Data Scientist"] }));
    const google = new URL(links[2].url);
    expect(google.searchParams.get("q")).toBe("Data Scientist jobs");
  });

  it("caps skills folded into the keyword phrase at MAX_DEEP_LINK_SKILLS, keeping a sane URL length (#541)", () => {
    // MAX_SKILLS (query-builder.ts) can put up to 12 ranked skills into
    // query.skills; the deep-link keyword phrase should only carry the
    // top MAX_DEEP_LINK_SKILLS of those, not all of them.
    const twelveSkills = [
      "python", "java", "go", "rust", "ruby", "php",
      "swift", "kotlin", "scala", "sql", "html", "css",
    ];
    const links = buildDeepLinks(query({ titles: ["Engineer"], skills: twelveSkills }));
    const linkedin = new URL(links[0].url);
    const keywords = linkedin.searchParams.get("keywords") ?? "";
    for (const skill of twelveSkills.slice(0, MAX_DEEP_LINK_SKILLS)) {
      expect(keywords).toContain(skill);
    }
    for (const skill of twelveSkills.slice(MAX_DEEP_LINK_SKILLS)) {
      expect(keywords).not.toContain(skill);
    }
    // Sanity bound: the full URL stays well under common board/browser limits.
    expect(links[0].url.length).toBeLessThan(500);
  });

  it("adds location to LinkedIn's location param and Indeed's l param (#545)", () => {
    const links = buildDeepLinks(
      query({ titles: ["Engineer"], location: "Austin, TX" }),
    );
    const linkedin = new URL(links[0].url);
    const indeed = new URL(links[1].url);
    expect(linkedin.searchParams.get("location")).toBe("Austin, TX");
    expect(indeed.searchParams.get("l")).toBe("Austin, TX");
  });

  it("Google Jobs has no location param — left unchanged when location is set (#545)", () => {
    const links = buildDeepLinks(
      query({ titles: ["Engineer"], location: "Austin, TX" }),
    );
    const google = new URL(links[2].url);
    expect(google.searchParams.get("q")).toBe("Engineer jobs");
    expect(google.searchParams.has("location")).toBe(false);
  });

  it("omits location params entirely when query.location is absent (#545)", () => {
    const links = buildDeepLinks(query({ titles: ["Engineer"] }));
    const linkedin = new URL(links[0].url);
    const indeed = new URL(links[1].url);
    expect(linkedin.searchParams.has("location")).toBe(false);
    expect(indeed.searchParams.has("l")).toBe(false);
  });

  it("still produces valid URLs for a fully degenerate query (no title, no skills)", () => {
    const links = buildDeepLinks(query());
    const linkedin = new URL(links[0].url);
    const indeed = new URL(links[1].url);
    const google = new URL(links[2].url);
    expect(linkedin.searchParams.get("keywords")).toBeNull();
    expect(indeed.searchParams.get("q")).toBeNull();
    expect(google.searchParams.get("q")).toBe("jobs");
  });
});

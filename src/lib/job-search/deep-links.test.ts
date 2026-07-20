// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { buildDeepLinks } from "./deep-links.ts";
import type { JobQuery } from "./query-builder.ts";

function query(overrides: Partial<JobQuery> = {}): JobQuery {
  return { title: "", skills: [], ...overrides };
}

describe("buildDeepLinks", () => {
  it("returns one link each for LinkedIn, Indeed, and Google Jobs", () => {
    const links = buildDeepLinks(query({ title: "Software Engineer" }));
    expect(links.map((l) => l.label)).toEqual(["LinkedIn", "Indeed", "Google Jobs"]);
    for (const link of links) {
      expect(() => new URL(link.url)).not.toThrow();
    }
  });

  it("prefills keywords from seniority + title + skills, space-joined", () => {
    const links = buildDeepLinks(
      query({ title: "Backend Engineer", seniority: "Senior", skills: ["python", "go"] }),
    );
    const linkedin = new URL(links[0].url);
    expect(linkedin.searchParams.get("keywords")).toBe(
      "Senior Backend Engineer python go",
    );
    const indeed = new URL(links[1].url);
    expect(indeed.searchParams.get("q")).toBe("Senior Backend Engineer python go");
  });

  it("skips seniority when the title already contains it (no 'Senior Senior …')", () => {
    const links = buildDeepLinks(
      query({ title: "Senior Backend Engineer", seniority: "Senior", skills: ["go"] }),
    );
    const linkedin = new URL(links[0].url);
    expect(linkedin.searchParams.get("keywords")).toBe("Senior Backend Engineer go");
  });

  it("URL-encodes special characters in title/skills", () => {
    const links = buildDeepLinks(
      query({ title: "C++ Engineer & Architect", skills: ["c#", "R&D"] }),
    );
    const linkedin = new URL(links[0].url);
    // Round-trips through URLSearchParams decoding back to the original string.
    expect(linkedin.searchParams.get("keywords")).toBe("C++ Engineer & Architect c# R&D");
    // The raw query string must actually be percent/plus-encoded, not literal.
    expect(links[0].url).not.toContain("C++ Engineer & Architect");
    expect(links[0].url).toMatch(/keywords=/);
  });

  it("Google Jobs appends the word 'jobs' to the keyword string", () => {
    const links = buildDeepLinks(query({ title: "Data Scientist" }));
    const google = new URL(links[2].url);
    expect(google.searchParams.get("q")).toBe("Data Scientist jobs");
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

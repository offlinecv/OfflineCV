// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  buildCompanySearchLinks,
  buildCompanySearchUrl,
  COMPANY_SEARCH_LINKS,
  type CompanySearchLink,
} from "./company-search-link.ts";
import { buildSearchPlan } from "./search-plan.ts";
import type { JobQuery } from "./query-builder.ts";

function query(overrides: Partial<JobQuery> = {}): JobQuery {
  return { titles: [], skills: [], ...overrides };
}

describe("COMPANY_SEARCH_LINKS", () => {
  it("has a non-empty name and a valid url on every entry", () => {
    for (const link of COMPANY_SEARCH_LINKS) {
      expect(link.name.trim().length).toBeGreaterThan(0);
      expect(() => new URL(link.url)).not.toThrow();
    }
  });

  it("has no duplicate names", () => {
    const seen = new Set<string>();
    for (const link of COMPANY_SEARCH_LINKS) {
      expect(seen.has(link.name)).toBe(false);
      seen.add(link.name);
    }
  });
});

describe("buildCompanySearchUrl", () => {
  const withBoth: CompanySearchLink = {
    name: "Fixture Co",
    url: "https://careers.example.com/search",
    queryParam: "q",
    locationParam: "loc",
  };

  it("sets the query param when supported and non-empty", () => {
    const url = new URL(buildCompanySearchUrl(withBoth, { query: "Backend Engineer" }));
    expect(url.searchParams.get("q")).toBe("Backend Engineer");
  });

  it("URL-encodes &, #, a space, and a non-ASCII character", () => {
    const term = "C++ & Rësumé #1 Engineer";
    const url = buildCompanySearchUrl(withBoth, { query: term });
    // Round-trips through URLSearchParams decoding back to the original string.
    expect(new URL(url).searchParams.get("q")).toBe(term);
    // The raw query string must actually be percent/plus-encoded, not literal.
    expect(url).not.toContain(term);
    expect(() => new URL(url)).not.toThrow();
  });

  it("fills both query and location when both are supported", () => {
    const url = new URL(
      buildCompanySearchUrl(withBoth, { query: "Engineer", location: "Austin, TX" }),
    );
    expect(url.searchParams.get("q")).toBe("Engineer");
    expect(url.searchParams.get("loc")).toBe("Austin, TX");
  });

  it("drops a term for a hole the company does not support", () => {
    const queryOnly: CompanySearchLink = {
      name: "Fixture Co",
      url: "https://careers.example.com/search",
      queryParam: "q",
      // no locationParam
    };
    const url = new URL(
      buildCompanySearchUrl(queryOnly, { query: "Engineer", location: "Austin, TX" }),
    );
    expect(url.searchParams.get("q")).toBe("Engineer");
    expect(url.searchParams.has("loc")).toBe(false);
    expect(url.searchParams.has("location")).toBe(false);
  });

  it("never emits an empty param — a company with no query support still links to its careers search", () => {
    const noParams: CompanySearchLink = {
      name: "Fixture Co",
      url: "https://careers.example.com/search",
      // no queryParam, no locationParam
    };
    const url = buildCompanySearchUrl(noParams, { query: "Engineer", location: "Austin, TX" });
    expect(url).toBe("https://careers.example.com/search");
    expect(url).not.toContain("=");
  });

  it("never emits an empty param when the term itself is empty", () => {
    const url = buildCompanySearchUrl(withBoth, { query: "", location: "" });
    expect(url).toBe("https://careers.example.com/search");
  });
});

describe("buildCompanySearchLinks", () => {
  it("returns one link per registry entry, all valid URLs", () => {
    const links = buildCompanySearchLinks(query({ titles: ["Backend Engineer"] }));
    expect(links).toHaveLength(COMPANY_SEARCH_LINKS.length);
    expect(links.map((l) => l.label)).toEqual(COMPANY_SEARCH_LINKS.map((c) => c.name));
    for (const link of links) {
      expect(() => new URL(link.url)).not.toThrow();
    }
  });

  it("still produces valid URLs for a fully degenerate query (no title, no skills)", () => {
    const links = buildCompanySearchLinks(query());
    for (const link of links) {
      expect(() => new URL(link.url)).not.toThrow();
    }
  });

  it("sends ONLY the primary title — not the other titles, not the skills", () => {
    const links = buildCompanySearchLinks(
      query({
        titles: ["Sr. Engineering Manager", "Founder", "India Site Lead"],
        skills: ["People Management", "LLM Orchestration"],
      }),
    );
    const apple = new URL(links.find((l) => l.label === "Apple")!.url);
    expect(apple.searchParams.get("search")).toBe("Sr. Engineering Manager");
  });

  it("searches the ROLE HEAD of a scoped title, dropping the qualifier", () => {
    // The reported defect: this whole query returned zero postings on Apple's
    // own careers search. Two independent causes, both pinned here — the
    // trailing scope qualifier, and the ` - ` that Apple reads as a NOT.
    const links = buildCompanySearchLinks(
      query({ titles: ["Engineering Lead - Customer Experience", "Founder"] }),
    );
    const apple = new URL(links.find((l) => l.label === "Apple")!.url);
    expect(apple.searchParams.get("search")).toBe("Engineering Lead");
    expect(apple.searchParams.get("search")).not.toContain("-");
  });

  it("falls back to skills when the résumé yielded no title at all", () => {
    const links = buildCompanySearchLinks(query({ skills: ["Kubernetes", "Go", "Terraform"] }));
    const apple = new URL(links.find((l) => l.label === "Apple")!.url);
    expect(apple.searchParams.get("search")).toBe("Kubernetes Go Terraform");
  });

  it("does NOT change buildSearchPlan's output — the two paths are decoupled (#691)", () => {
    const q = query({ titles: ["Backend Engineer"], skills: ["go", "kubernetes"] });
    const before = buildSearchPlan(q, 2);
    buildCompanySearchLinks(q);
    const after = buildSearchPlan(q, 2);
    expect(after).toEqual(before);
  });
});

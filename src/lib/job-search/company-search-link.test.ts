// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  buildCompanySearchLinks,
  buildCompanySearchTerms,
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
    // Google carries no dialect, so it shows the base derivation untouched.
    expect(new URL(links.find((l) => l.label === "Google")!.url).searchParams.get("q")).toBe(
      "Sr. Engineering Manager",
    );
    // Apple narrows the same base phrase per its measured dialect (#697).
    expect(new URL(links.find((l) => l.label === "Apple")!.url).searchParams.get("search")).toBe(
      '"Engineering Manager"',
    );
  });

  it("searches the ROLE HEAD of a scoped title, dropping the qualifier", () => {
    // The reported defect: this whole query returned zero postings on Apple's
    // own careers search. Two independent causes, both pinned here — the
    // trailing scope qualifier, and the ` - ` that Apple reads as a NOT.
    const links = buildCompanySearchLinks(
      query({ titles: ["Engineering Lead - Customer Experience", "Founder"] }),
    );
    const apple = new URL(links.find((l) => l.label === "Apple")!.url);
    expect(apple.searchParams.get("search")).toBe('"Engineering Lead"');
    expect(apple.searchParams.get("search")).not.toContain("-");
  });

  it("falls back to skills when the résumé yielded no title at all", () => {
    const links = buildCompanySearchLinks(query({ skills: ["Kubernetes", "Go", "Terraform"] }));
    const apple = new URL(links.find((l) => l.label === "Apple")!.url);
    expect(apple.searchParams.get("search")).toBe('"Kubernetes Go Terraform"');
  });

  it("does NOT change buildSearchPlan's output — the two paths are decoupled (#691)", () => {
    const q = query({ titles: ["Backend Engineer"], skills: ["go", "kubernetes"] });
    const before = buildSearchPlan(q, 2);
    buildCompanySearchLinks(q);
    const after = buildSearchPlan(q, 2);
    expect(after).toEqual(before);
  });
});

/**
 * The per-destination dialect (#697). Every expectation below is pinned to a
 * measurement recorded in the module docblock — see that table before changing
 * one, and before adding a dialect to a row that does not have one.
 */
describe("buildCompanySearchLinks — per-company dialect (#697)", () => {
  const appleSearch = (q: JobQuery): string | null =>
    new URL(buildCompanySearchLinks(q).find((l) => l.label === "Apple")!.url).searchParams.get(
      "search",
    );
  const appleUrl = (q: JobQuery): URL =>
    new URL(buildCompanySearchLinks(q).find((l) => l.label === "Apple")!.url);

  it("AC1 — quotes the phrase and drops a leading seniority modifier for Apple", () => {
    // Measured: `Sr. Engineering Manager` → 243 results, 8/8 senior ICs on page
    // one; `"Engineering Manager"` → 120, all genuine EM.
    expect(appleSearch(query({ titles: ["Sr. Engineering Manager"] }))).toBe(
      '"Engineering Manager"',
    );
  });

  it.each([
    ["Sr. Engineering Manager", '"Engineering Manager"'],
    ["Sr Engineering Manager", '"Engineering Manager"'],
    ["Senior Engineering Manager", '"Engineering Manager"'],
    ["Jr. Backend Engineer", '"Backend Engineer"'],
    ["Junior Backend Engineer", '"Backend Engineer"'],
  ])("AC1 — %s searches as %s", (title, expected) => {
    expect(appleSearch(query({ titles: [title] }))).toBe(expected);
  });

  it("AC2 — resolves a free-text location through the slug vocabulary", () => {
    const url = appleUrl(query({ titles: ["Engineering Manager"], location: "Santa Clara, CA" }));
    expect(url.searchParams.get("location")).toBe("santa-clara-valley-cupertino-SCV");
  });

  it.each([
    ["Santa Clara, CA", "santa-clara-valley-cupertino-SCV"],
    ["Santa Clara Valley", "santa-clara-valley-cupertino-SCV"],
    ["  cupertino  ", "santa-clara-valley-cupertino-SCV"],
    ["SUNNYVALE", "santa-clara-valley-cupertino-SCV"],
    ["San   Jose, CA", "san-jose-SJS"],
    ["Seattle, WA", "seattle-SEA"],
    ["New York City", "new-york-city-NYC"],
    ["California", "california-state953"],
    ["Remote", "united-states-USA"],
  ])("AC2 — %s resolves to %s", (location, slug) => {
    expect(appleUrl(query({ titles: ["Engineering Manager"], location })).searchParams.get(
      "location",
    )).toBe(slug);
  });

  it("AC3 — a location absent from the vocabulary OMITS the param entirely", () => {
    // Free text returns a hard zero on Apple ("There are no results that match
    // your search"), which reads as "no roles here" and is unrecoverable. An
    // unfiltered nationwide page is recoverable in two clicks, so a miss must
    // send nothing — not the free text, not an empty param.
    const url = appleUrl(query({ titles: ["Engineering Manager"], location: "Reykjavik" }));
    expect(url.searchParams.has("location")).toBe(false);
    expect(url.toString()).not.toContain("Reykjavik");
    expect(url.toString()).not.toContain("location=");
    // The query term still ships — a location miss narrows nothing else.
    expect(url.searchParams.get("search")).toBe('"Engineering Manager"');
  });

  it.each([
    ["Engineering Manager", '"Engineering Manager"'],
    ["Engineering Lead", '"Engineering Lead"'],
    ["Staff Engineer", '"Staff Engineer"'],
    ["Principal Engineer", '"Principal Engineer"'],
    ["Head of Platform", '"Head of Platform"'],
    ["Director of Engineering", '"Director of Engineering"'],
  ])("AC4 — %s survives the transform with only quotes added", (title, expected) => {
    // `parseSeniorityLabel` calls Manager/Lead/Staff/Principal/Director/Head of
    // seniority labels. Subtracting on that vocabulary would delete the ROLE
    // NOUN — the #605 defect class. Only a LEADING Sr./Senior/Jr./Junior goes.
    expect(appleSearch(query({ titles: [title] }))).toBe(expected);
  });

  it("AC4 — a seniority word that is not at the head is never touched", () => {
    expect(appleSearch(query({ titles: ["Engineering Manager, Senior Platform"] }))).toBe(
      '"Engineering Manager, Senior Platform"',
    );
  });

  it("AC4 — a phrase that is only a seniority modifier is not emptied", () => {
    expect(appleSearch(query({ titles: ["Senior"] }))).toBe('"Senior"');
  });

  it("AC4 — a word merely STARTING with sr/jr is not a prefix match", () => {
    expect(appleSearch(query({ titles: ["Sriram Systems Engineer"] }))).toBe(
      '"Sriram Systems Engineer"',
    );
  });

  it("AC5 — the #696 operator strip still fires under quoting", () => {
    // Ordering proof: quoting runs AFTER `stripSearchOperators`. Reversed, the
    // leading `"` would stop the first token from starting with `-` and the
    // bare NOT operator would ride into the quoted phrase.
    const scoped = appleSearch(query({ titles: ["Engineering Lead - Customer Experience"] }));
    expect(scoped).toBe('"Engineering Lead"');
    expect(scoped).not.toContain("-");

    // A leading `-` that `roleHeadForSearch` does NOT split on (no space before
    // it) reaches `stripSearchOperators` and must still be neutralized.
    const leadingDash = appleSearch(query({ titles: ["- Customer Experience"] }));
    expect(leadingDash).toBe('"Customer Experience"');
    expect(leadingDash).not.toContain("-");
  });

  it("AC6 — a skills-only query still produces a working, non-empty link", () => {
    const url = appleUrl(query({ skills: ["Kubernetes", "Go", "Terraform"] }));
    expect(url.searchParams.get("search")).toBe('"Kubernetes Go Terraform"');
    expect(() => new URL(url.toString())).not.toThrow();
  });

  it("AC6 — a fully degenerate query degrades to the bare careers URL, never search=\"\"", () => {
    const url = appleUrl(query());
    expect(url.searchParams.has("search")).toBe(false);
    expect(url.toString()).toBe("https://jobs.apple.com/en-us/search");
  });

  it("AC7 — Amazon, Google, Meta and Tesla are BYTE-IDENTICAL to their pre-#697 output", () => {
    // Captured from the pre-#697 derivation (one term pair for all six rows:
    // `stripSearchOperators(roleHeadForSearch(searchPhrase(q)))` + the raw
    // `buildLocationParam`). These four destinations are UNMEASURED — their
    // results are client-rendered and invisible to a plain fetch — so they get
    // no dialect. This assertion is the guard that keeps someone from adding
    // one on inference; if it fails, a measurement is owed, not an update.
    const q = query({ titles: ["Sr. Engineering Manager"], location: "Santa Clara, CA" });
    const byLabel = new Map(buildCompanySearchLinks(q).map((l) => [l.label, l.url]));

    expect(byLabel.get("Amazon")).toBe(
      "https://www.amazon.jobs/en/search?base_query=Sr.+Engineering+Manager&loc_query=Santa+Clara%2C+CA",
    );
    expect(byLabel.get("Google")).toBe(
      "https://www.google.com/about/careers/applications/jobs/results?q=Sr.+Engineering+Manager",
    );
    expect(byLabel.get("Meta")).toBe("https://www.metacareers.com/jobs?q=Sr.+Engineering+Manager");
    expect(byLabel.get("Tesla")).toBe(
      "https://www.tesla.com/careers/search/?query=Sr.+Engineering+Manager",
    );
  });

  it("AC7 — the four unmeasured rows declare no dialect and no slug vocabulary", () => {
    for (const name of ["Amazon", "Google", "Meta", "Tesla"]) {
      const link = COMPANY_SEARCH_LINKS.find((l) => l.name === name)!;
      expect(link.dialect).toBeUndefined();
      expect(link.locationSlugs).toBeUndefined();
    }
  });

  const netflixUrl = (q: JobQuery): URL =>
    new URL(buildCompanySearchLinks(q).find((l) => l.label === "Netflix")!.url);

  it("Netflix quotes a seniority-free phrase and keeps free-text location — no slug table", () => {
    // Measured 2026-07-31: bare `engineering manager` + `location=Los Gatos` →
    // 40 results; quoted → 13, identical top-5 in the same order. That
    // measurement is on a phrase with NO seniority prefix, which is the only
    // shape `phraseQuote` fires on here.
    const url = netflixUrl(query({ titles: ["Engineering Manager"], location: "Los Gatos" }));
    expect(url.searchParams.get("query")).toBe('"Engineering Manager"');
    expect(url.searchParams.get("location")).toBe("Los Gatos");
  });

  it("Netflix does NOT quote a phrase that still carries a seniority modifier", () => {
    // The two dialect flags INTERACT — they do not compose independently. The
    // Apple table measures `"Sr. Engineering Manager"` + a metro location at a
    // hard ZERO and the same phrase unquoted at 243, so quoting a
    // seniority-bearing phrase alongside a location is the measured fail-zero
    // shape. Netflix carries no `dropSeniorityPrefix` (unmeasured there), so
    // `phraseQuote` declines rather than emit that shape: pre-#697 output.
    const url = netflixUrl(query({ titles: ["Sr. Engineering Manager"], location: "Los Gatos" }));
    expect(url.searchParams.get("query")).toBe("Sr. Engineering Manager");
    expect(url.searchParams.get("location")).toBe("Los Gatos");
  });

  it.each([
    ["Sr. Engineering Manager", "Sr. Engineering Manager"],
    ["Senior Engineering Manager", "Senior Engineering Manager"],
    ["Jr. Backend Engineer", "Jr. Backend Engineer"],
  ])("Netflix — %s stays unquoted", (title, expected) => {
    expect(netflixUrl(query({ titles: [title] })).searchParams.get("query")).toBe(expected);
  });

  it("Apple is unchanged by the quoting guard — the strip runs first", () => {
    // The guard tests the phrase AFTER `dropSeniorityPrefix`, so Apple's
    // measured behaviour is untouched: the modifier is gone before quoting.
    const withPrefix = query({ titles: ["Sr. Engineering Manager"], location: "Los Gatos" });
    expect(appleSearch(withPrefix)).toBe('"Engineering Manager"');
    expect(appleSearch(query({ titles: ["Engineering Manager"] }))).toBe(
      '"Engineering Manager"',
    );
  });

  it.each([
    ["Senior Manager", "Senior Manager"],
    ["Senior Director", "Senior Director"],
    ["Senior Engineer", "Senior Engineer"],
    ["Sr. Manager", "Sr. Manager"],
  ])(
    "a strip that would leave a SINGLE generic token is declined — %s stays %s",
    (title, expected) => {
      // `Senior Manager` → `Manager` is exactly defect 1 in the module docblock
      // ("Manager alone drags in retail store managers"), so the strip is
      // declined; the phrase then still carries the modifier, so the quoting
      // guard declines too and Apple emits its pre-#697 output.
      expect(appleSearch(query({ titles: [title] }))).toBe(expected);
    },
  );

  it("a three-token title still strips — the carve-out is single-token only", () => {
    expect(appleSearch(query({ titles: ["Senior Platform Engineer"] }))).toBe(
      '"Platform Engineer"',
    );
  });
});

describe("buildCompanySearchTerms", () => {
  it("is a function of (query, link) — the same query yields different terms per row", () => {
    const q = query({ titles: ["Sr. Engineering Manager"], location: "Santa Clara, CA" });
    const apple = COMPANY_SEARCH_LINKS.find((l) => l.name === "Apple")!;
    const google = COMPANY_SEARCH_LINKS.find((l) => l.name === "Google")!;

    expect(buildCompanySearchTerms(q, apple)).toEqual({
      query: '"Engineering Manager"',
      location: "santa-clara-valley-cupertino-SCV",
    });
    expect(buildCompanySearchTerms(q, google)).toEqual({
      query: "Sr. Engineering Manager",
      location: "Santa Clara, CA",
    });
  });

  it("passes location through unresolved for a row with no slug vocabulary", () => {
    const freeText: CompanySearchLink = {
      name: "Fixture Co",
      url: "https://careers.example.com/search",
      queryParam: "q",
      locationParam: "loc",
    };
    expect(buildCompanySearchTerms(query({ location: "Reykjavik" }), freeText).location).toBe(
      "Reykjavik",
    );
  });
});

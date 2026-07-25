// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  ROLE_KEYWORDS,
  ROLE_FAMILIES,
  roleFilterForResume,
  roleFilterForFamilies,
  filterPostingsByRole,
  filterPostingsByExcludeTerms,
  seedExcludeTermsForFamilies,
  capPerCompany,
  scoreByTitleAgainstQuery,
  orderPostingsByTitleScore,
  DEFAULT_PER_COMPANY_CAP,
  type RoleFilter,
} from "./role-keywords.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobPosting } from "./types.ts";
import type { JobQuery } from "./query-builder.ts";

// Minimal typed stub over the parsed model, like contact.test.ts / sector.test.ts
// — only the fields role-keywords reads (experience titles + headline/current_title).
function makeParsed(
  overrides: Partial<HeuristicParsedResume> = {},
): HeuristicParsedResume {
  return {
    skills: [],
    experience: [],
    education: [],
    ...overrides,
  };
}

// Minimal JobPosting stub — only fields the filter/cap read matter.
function makePosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: overrides.id ?? "test:1",
    title: overrides.title ?? "",
    company: overrides.company ?? "Acme",
    location: overrides.location ?? "",
    url: overrides.url ?? "https://example.com",
    description: overrides.description ?? "",
    source: overrides.source ?? "Test",
    ...overrides,
  };
}

describe("ROLE_KEYWORDS taxonomy", () => {
  it("has an entry for every family with non-empty, lowercased keywords", () => {
    expect(ROLE_FAMILIES.length).toBeGreaterThanOrEqual(12);
    expect(ROLE_FAMILIES.length).toBeLessThanOrEqual(20);
    for (const family of ROLE_FAMILIES) {
      const keywords = ROLE_KEYWORDS[family];
      expect(keywords.length).toBeGreaterThan(0);
      for (const kw of keywords) {
        expect(kw.length).toBeGreaterThan(0);
        expect(kw).toBe(kw.toLowerCase());
      }
    }
  });
});

describe("roleFilterForResume — titles, not skills", () => {
  it("maps a frontend-titled resume to the frontend family with front-end/react keywords", () => {
    const filter = roleFilterForResume(
      makeParsed({
        experience: [
          { title: "Senior Frontend Engineer", company: "Acme" },
          { title: "Front End Developer", company: "Globex" },
        ],
      }),
    );
    expect(filter.families).toContain("frontend");
    expect(filter.families[0]).toBe("frontend");
    expect(filter.keywords).toContain("front end");
    expect(filter.keywords).toContain("react developer");
    expect(filter.source).toBe("heuristic");
  });

  it("maps a data-titled resume to the data family", () => {
    const filter = roleFilterForResume(
      makeParsed({
        experience: [{ title: "Senior Data Engineer", company: "Acme" }],
      }),
    );
    expect(filter.families).toContain("data");
  });

  it("reads the standalone headline / current_title target-role signal", () => {
    const filter = roleFilterForResume(
      makeParsed({
        experience: [],
        headline: "Product Manager",
        current_title: "Group Product Manager",
      }),
    );
    expect(filter.families).toContain("pm");
    expect(filter.keywords).toContain("product manager");
  });

  it("classifies from TITLES ONLY — skills matching a family do NOT classify it", () => {
    // Skills scream frontend; the only TITLE is a sales role. The filter must
    // reflect the title (sales), never the skills (frontend).
    const filter = roleFilterForResume(
      makeParsed({
        skills: ["React", "TypeScript", "CSS", "Frontend", "Web"],
        experience: [{ title: "Account Executive", company: "Acme" }],
      }),
    );
    expect(filter.families).toContain("sales");
    expect(filter.families).not.toContain("frontend");
    expect(filter.keywords).not.toContain("front end");
  });

  it("empty resume yields a permissive 'all' filter (never zero)", () => {
    const filter = roleFilterForResume(makeParsed());
    expect(filter.families).toEqual([]);
    expect(filter.keywords).toEqual([]);
    expect(filter.source).toBe("heuristic");
  });

  it("degenerate resume with unrecognized titles yields the permissive 'all' filter", () => {
    const filter = roleFilterForResume(
      makeParsed({
        skills: ["Communication"],
        experience: [{ title: "Chief Vibes Officer", company: "Somewhere" }],
      }),
    );
    expect(filter.families).toEqual([]);
    expect(filter.keywords).toEqual([]);
  });

  it("keeps at most 2 dominant families, dominant first", () => {
    const filter = roleFilterForResume(
      makeParsed({
        experience: [
          { title: "Frontend Engineer", company: "A" },
          { title: "Frontend Engineer", company: "B" },
          { title: "Backend Engineer", company: "C" },
          { title: "Data Engineer", company: "D" },
        ],
      }),
    );
    expect(filter.families.length).toBeLessThanOrEqual(2);
    expect(filter.families[0]).toBe("frontend"); // score 2 beats the 1s
  });

  // A lopsided split is the career-switcher case: `score > 0` alone would keep
  // "design", whose broad keywords ("designer", "user experience") then match
  // every Designer posting on every board.
  it("drops a runner-up family that trails the winner by more than half", () => {
    const filter = roleFilterForResume(
      makeParsed({
        experience: [
          { title: "Backend Engineer", company: "A" },
          { title: "Senior Backend Engineer", company: "B" },
          { title: "Staff Backend Engineer", company: "C" },
          { title: "UX Designer", company: "D" },
        ],
      }),
    );
    expect(filter.families).toEqual(["backend"]);
    expect(filter.keywords).not.toContain("designer");
  });

  it("never throws on a malformed/empty parsed model", () => {
    expect(() => roleFilterForResume(makeParsed())).not.toThrow();
  });
});

describe("roleFilterForFamilies (issue 568)", () => {
  it("builds a filter from an explicit single family, matching roleFilterForResume's keywords for it", () => {
    const filter = roleFilterForFamilies(["backend"]);
    expect(filter.families).toEqual(["backend"]);
    expect(filter.keywords).toEqual(ROLE_KEYWORDS.backend);
  });

  it("unions keywords across multiple explicit families, deduped", () => {
    const filter = roleFilterForFamilies(["frontend", "backend"]);
    expect(filter.families).toEqual(["frontend", "backend"]);
    expect(filter.keywords).toEqual(
      expect.arrayContaining([...ROLE_KEYWORDS.frontend, ...ROLE_KEYWORDS.backend]),
    );
    expect(new Set(filter.keywords).size).toBe(filter.keywords.length);
  });

  it("never fails closed: an empty family list resolves to the permissive 'all' filter", () => {
    const filter = roleFilterForFamilies([]);
    expect(filter).toEqual({ families: [], keywords: [], source: "heuristic" });
    // And that permissive filter is a true no-op through filterPostingsByRole.
    const postings = [makePosting({ title: "Forklift Operator" })];
    expect(filterPostingsByRole(postings, filter)).toEqual(postings);
  });

  it("narrows the same board differently than the union it was drawn from", () => {
    const postings = [
      makePosting({ id: "fe", title: "Frontend Engineer" }),
      makePosting({ id: "be", title: "Backend Engineer" }),
    ];
    const both = roleFilterForFamilies(["frontend", "backend"]);
    expect(filterPostingsByRole(postings, both).map((p) => p.id).sort()).toEqual([
      "be",
      "fe",
    ]);
    const backendOnly = roleFilterForFamilies(["backend"]);
    expect(filterPostingsByRole(postings, backendOnly).map((p) => p.id)).toEqual(["be"]);
  });
});

describe("filterPostingsByRole", () => {
  const frontendFilter = roleFilterForResume(
    makeParsed({ experience: [{ title: "Frontend Engineer", company: "X" }] }),
  );

  it("keeps a matching title and drops a non-matching one", () => {
    const postings = [
      makePosting({ id: "1", title: "Senior Frontend Engineer" }),
      makePosting({ id: "2", title: "Account Executive" }),
    ];
    const kept = filterPostingsByRole(postings, frontendFilter);
    expect(kept.map((p) => p.id)).toEqual(["1"]);
  });

  it("matches case-insensitively", () => {
    const postings = [makePosting({ id: "1", title: "SENIOR FRONTEND ENGINEER" })];
    expect(filterPostingsByRole(postings, frontendFilter)).toHaveLength(1);
  });

  it("matches both hyphen and space title variants", () => {
    const postings = [
      makePosting({ id: "hyphen", title: "Front-End Developer" }),
      makePosting({ id: "space", title: "Front End Developer" }),
    ];
    const kept = filterPostingsByRole(postings, frontendFilter);
    expect(kept.map((p) => p.id).sort()).toEqual(["hyphen", "space"]);
  });

  it("optionally matches on departments[] when the title alone does not", () => {
    const filter = roleFilterForResume(
      makeParsed({ experience: [{ title: "Data Engineer", company: "X" }] }),
    );
    const postings = [
      makePosting({ id: "dept", title: "Engineer II", departments: ["Data Platform"] }),
    ];
    expect(filterPostingsByRole(postings, filter)).toHaveLength(1);
  });

  it("preserves input order", () => {
    const postings = [
      makePosting({ id: "a", title: "Frontend Engineer" }),
      makePosting({ id: "b", title: "Account Executive" }),
      makePosting({ id: "c", title: "Web Developer" }),
    ];
    expect(filterPostingsByRole(postings, frontendFilter).map((p) => p.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns the input UNCHANGED for an 'all' filter (no accidental narrowing)", () => {
    const allFilter: RoleFilter = { families: [], keywords: [], source: "heuristic" };
    const postings = [
      makePosting({ id: "1", title: "Account Executive" }),
      makePosting({ id: "2", title: "Barista" }),
    ];
    const kept = filterPostingsByRole(postings, allFilter);
    expect(kept).toBe(postings);
    expect(kept).toHaveLength(2);
  });
});

describe("capPerCompany", () => {
  it("returns at most N per company, preserving order", () => {
    const postings = [
      makePosting({ id: "a1", company: "Acme" }),
      makePosting({ id: "a2", company: "Acme" }),
      makePosting({ id: "a3", company: "Acme" }),
      makePosting({ id: "g1", company: "Globex" }),
      makePosting({ id: "a4", company: "Acme" }),
    ];
    const capped = capPerCompany(postings, 2);
    expect(capped.map((p) => p.id)).toEqual(["a1", "a2", "g1"]);
  });

  it("counts companies case-insensitively / trimmed", () => {
    const postings = [
      makePosting({ id: "1", company: "Acme" }),
      makePosting({ id: "2", company: " acme " }),
      makePosting({ id: "3", company: "ACME" }),
    ];
    expect(capPerCompany(postings, 2)).toHaveLength(2);
  });

  it("keeps everything when under the cap", () => {
    const postings = [
      makePosting({ id: "1", company: "A" }),
      makePosting({ id: "2", company: "B" }),
    ];
    expect(capPerCompany(postings, DEFAULT_PER_COMPANY_CAP)).toHaveLength(2);
  });

  it("keeps none for a non-positive limit", () => {
    const postings = [makePosting({ id: "1", company: "A" })];
    expect(capPerCompany(postings, 0)).toEqual([]);
  });
});

describe("scoreByTitleAgainstQuery", () => {
  it("scores 0 when the query has no derivable titles (degenerate query)", () => {
    const query: JobQuery = { titles: [], skills: [] };
    const posting = makePosting({ title: "Backend Engineer" });
    expect(scoreByTitleAgainstQuery(posting, query)).toBe(0);
  });

  it("scores higher for more overlapping title words", () => {
    const query: JobQuery = { titles: ["Senior Backend Engineer"], skills: [] };
    const strong = makePosting({ title: "Senior Backend Engineer" });
    const weak = makePosting({ title: "Backend Support Specialist" });
    const none = makePosting({ title: "Marketing Manager" });
    expect(scoreByTitleAgainstQuery(strong, query)).toBeGreaterThan(
      scoreByTitleAgainstQuery(weak, query),
    );
    expect(scoreByTitleAgainstQuery(weak, query)).toBeGreaterThan(
      scoreByTitleAgainstQuery(none, query),
    );
  });

  it("reads departments as part of the haystack", () => {
    const query: JobQuery = { titles: ["Data Scientist"], skills: [] };
    const posting = makePosting({ title: "Analyst", departments: ["Data Science"] });
    expect(scoreByTitleAgainstQuery(posting, query)).toBeGreaterThan(0);
  });

  it("nudges a same-rung seniority match without dominating word overlap", () => {
    const query: JobQuery = {
      titles: ["Staff Engineer"],
      skills: [],
      seniority: "Staff",
    };
    const sameLevel = makePosting({ title: "Staff Engineer" });
    const offLevel = makePosting({ title: "Junior Engineer" });
    expect(scoreByTitleAgainstQuery(sameLevel, query)).toBeGreaterThan(
      scoreByTitleAgainstQuery(offLevel, query),
    );
    // A pure title mismatch with no seniority signal never outranks a real
    // word-overlap match just because the levels happen to line up.
    const noOverlapSameLevel = makePosting({ title: "Staff Accountant" });
    expect(scoreByTitleAgainstQuery(sameLevel, query)).toBeGreaterThan(
      scoreByTitleAgainstQuery(noOverlapSameLevel, query),
    );
  });
});

describe("orderPostingsByTitleScore", () => {
  it("keeps board order when every score is 0 (never-fail-closed)", () => {
    const query: JobQuery = { titles: [], skills: [] };
    const postings = [
      makePosting({ id: "1" }),
      makePosting({ id: "2" }),
      makePosting({ id: "3" }),
    ];
    expect(orderPostingsByTitleScore(postings, query).map((p) => p.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("never drops or adds a posting — reorders only", () => {
    const query: JobQuery = { titles: ["Backend Engineer"], skills: [] };
    const postings = Array.from({ length: 10 }, (_, i) =>
      makePosting({ id: `p${i}`, title: i === 3 ? "Backend Engineer" : "Sales Rep" }),
    );
    const ordered = orderPostingsByTitleScore(postings, query);
    expect(ordered).toHaveLength(postings.length);
    expect(new Set(ordered.map((p) => p.id))).toEqual(new Set(postings.map((p) => p.id)));
  });

  it("acceptance: the strongest title match at index 30 of 40 survives the per-company cap", () => {
    const query: JobQuery = { titles: ["Staff Backend Engineer"], skills: [] };
    const postings: JobPosting[] = Array.from({ length: 40 }, (_, i) =>
      makePosting({
        id: `job-${i}`,
        company: "BigCo",
        title: i === 30 ? "Staff Backend Engineer" : `Generic Role ${i}`,
      }),
    );

    const ordered = orderPostingsByTitleScore(postings, query);
    const survivors = capPerCompany(ordered, DEFAULT_PER_COMPANY_CAP);

    expect(survivors.some((p) => p.id === "job-30")).toBe(true);
    // Sanity: a prefix-of-board-order cap (pre-#565 behavior) would have
    // missed it — index 30 is well past DEFAULT_PER_COMPANY_CAP (8).
    expect(postings.findIndex((p) => p.id === "job-30")).toBeGreaterThan(
      DEFAULT_PER_COMPANY_CAP,
    );
  });
});

describe("filterPostingsByExcludeTerms (issue 563)", () => {
  it("drops a posting whose TITLE matches an exclude term, case-insensitively", () => {
    const postings = [
      makePosting({ id: "a", title: "Solutions Architect" }),
      makePosting({ id: "b", title: "Senior Backend Engineer" }),
    ];
    const { postings: kept, suppressed } = filterPostingsByExcludeTerms(
      postings,
      ["solutions architect"],
    );
    expect(kept.map((p) => p.id)).toEqual(["b"]);
    expect(suppressed).toBe(false);
  });

  it("does NOT match a description-only mention of the excluded phrase", () => {
    const postings = [
      makePosting({
        id: "a",
        title: "Backend Engineer",
        description: "You will partner with our solutions architect team.",
      }),
    ];
    const { postings: kept } = filterPostingsByExcludeTerms(postings, [
      "solutions architect",
    ]);
    expect(kept.map((p) => p.id)).toEqual(["a"]);
  });

  it("is a no-op for empty excludeTerms — byte-identical to the input array contents", () => {
    const postings = [makePosting({ id: "a" }), makePosting({ id: "b" })];
    expect(filterPostingsByExcludeTerms(postings, [])).toEqual({
      postings,
      suppressed: false,
    });
    expect(filterPostingsByExcludeTerms(postings, undefined)).toEqual({
      postings,
      suppressed: false,
    });
  });

  it("never fails closed: skips the exclusion and returns the input when it would empty a non-empty set", () => {
    const postings = [
      makePosting({ id: "a", title: "Backend Engineer" }),
      makePosting({ id: "b", title: "Backend Engineer II" }),
    ];
    const { postings: kept, suppressed } = filterPostingsByExcludeTerms(
      postings,
      ["engineer"],
    );
    expect(kept).toEqual(postings);
    expect(suppressed).toBe(true);
  });

  it("an empty input stays empty and unsuppressed", () => {
    expect(filterPostingsByExcludeTerms([], ["anything"])).toEqual({
      postings: [],
      suppressed: false,
    });
  });
});

describe("seedExcludeTermsForFamilies (issue 563)", () => {
  it("seeds the GTM/field-role negatives for an engineering-adjacent family", () => {
    const seeds = seedExcludeTermsForFamilies(["backend"]);
    expect(seeds).toContain("solutions architect");
    expect(seeds).toContain("forward deployed engineer");
    expect(seeds).toContain("developer advocate");
  });

  it("seeds nothing for a sales-family query — must NOT seed engineering negatives against itself", () => {
    expect(seedExcludeTermsForFamilies(["sales"])).toEqual([]);
  });

  it("seeds nothing for the permissive 'all' filter (no classified family)", () => {
    expect(seedExcludeTermsForFamilies([])).toEqual([]);
  });
});

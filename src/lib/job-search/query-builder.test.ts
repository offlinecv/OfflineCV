// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { buildJobQuery, MAX_SKILLS, MAX_TITLES } from "./query-builder.ts";
import type { ParsedResume, ResumeExperience } from "../score/types.ts";

function baseParsed(overrides: Partial<ParsedResume> = {}): ParsedResume {
  return {
    full_name: "Jamie Rivera",
    skills: [],
    experience: [],
    education: [],
    skills_explicit: [],
    skills_inferred: [],
    ...overrides,
  };
}

function experience(overrides: Partial<ResumeExperience> = {}): ResumeExperience {
  return {
    title: "Software Engineer",
    company: "Acme Corp",
    ...overrides,
  };
}

describe("buildJobQuery", () => {
  it("returns an empty query for a fully empty resume", () => {
    const query = buildJobQuery(baseParsed());
    expect(query).toEqual({
      titles: [],
      skills: [],
      seniority: undefined,
      location: undefined,
    });
  });

  it("seeds location from the parsed résumé's top-level location (#545)", () => {
    const query = buildJobQuery(baseParsed({ location: "Austin, TX" }));
    expect(query.location).toBe("Austin, TX");
  });

  it("leaves location undefined when the parse has none (#545)", () => {
    const query = buildJobQuery(baseParsed());
    expect(query.location).toBeUndefined();
  });

  it("trims location and treats whitespace-only as absent (#545)", () => {
    expect(buildJobQuery(baseParsed({ location: "  Denver, CO  " })).location).toBe(
      "Denver, CO",
    );
    expect(buildJobQuery(baseParsed({ location: "   " })).location).toBeUndefined();
  });

  it("derives the distinct titles across experience, most-recent-first", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Staff Software Engineer" }),
        experience({ title: "Software Engineer II" }),
      ],
    });
    const query = buildJobQuery(parsed);
    expect(query.titles).toEqual([
      "Staff Software Engineer",
      "Software Engineer II",
    ]);
    // titles[0] is the primary (most-recent) title.
    expect(query.titles[0]).toBe("Staff Software Engineer");
  });

  it("dedups titles case-insensitively, keeping first-seen order + casing", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Engineering Manager" }),
        experience({ title: "Staff Engineer" }),
        experience({ title: "engineering MANAGER" }), // dup of the first, case-only
        experience({ title: "  Staff Engineer  " }), // dup after trim
      ],
    });
    const query = buildJobQuery(parsed);
    expect(query.titles).toEqual(["Engineering Manager", "Staff Engineer"]);
  });

  it("caps titles at MAX_TITLES, keeping the most-recent ones", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "T1" }),
        experience({ title: "T2" }),
        experience({ title: "T3" }),
        experience({ title: "T4" }),
        experience({ title: "T5" }),
        experience({ title: "T6" }),
      ],
    });
    const query = buildJobQuery(parsed);
    expect(query.titles).toHaveLength(MAX_TITLES);
    expect(query.titles).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("skips blank experience titles when deriving titles", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "   " }),
        experience({ title: "Product Manager" }),
      ],
    });
    expect(buildJobQuery(parsed).titles).toEqual(["Product Manager"]);
  });

  it("falls back to current_title (as a single title) when there is no experience title", () => {
    const parsed = baseParsed({ current_title: "Product Manager" });
    const query = buildJobQuery(parsed);
    expect(query.titles).toEqual(["Product Manager"]);
  });

  it("does not use current_title when experience already yields a title", () => {
    const parsed = baseParsed({
      current_title: "Product Manager",
      experience: [experience({ title: "Staff Engineer" })],
    });
    expect(buildJobQuery(parsed).titles).toEqual(["Staff Engineer"]);
  });

  it("falls back to skills-only query when there is no experience and no current_title", () => {
    const parsed = baseParsed({ skills: ["Python", "SQL"] });
    const query = buildJobQuery(parsed);
    expect(query.titles).toEqual([]);
    expect(query.skills).toEqual(["python", "sql"]);
    expect(query.seniority).toBeUndefined();
  });

  it("derives seniority from a keyword in the title", () => {
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Senior Backend Engineer" })] }),
      ).seniority,
    ).toBe("Senior");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Staff Platform Engineer" })] }),
      ).seniority,
    ).toBe("Staff");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Junior Developer" })] }),
      ).seniority,
    ).toBe("Junior");
  });

  it("prefers a PRIMARY title match over a later title's keyword (#539)", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Engineering Manager" }), // primary: matches Manager
        experience({ title: "Staff Engineer" }), // later: Staff, must NOT win
      ],
    });
    expect(buildJobQuery(parsed).seniority).toBe("Manager");
  });

  it("falls back to a later title's keyword when the primary has none (#540)", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Board Member" }), // primary: no keyword
        experience({ title: "Staff Engineer" }), // fallback match
      ],
    });
    expect(buildJobQuery(parsed).seniority).toBe("Staff");
  });

  it("falls back across multiple titles to find an exec title after a primary board seat (#540)", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Board Member" }), // primary: no keyword
        experience({ title: "Advisor" }), // still no keyword
        experience({ title: "Chief Executive Officer" }), // fallback match
      ],
    });
    expect(buildJobQuery(parsed).seniority).toBe("Executive");
  });

  it("leaves seniority undefined when no title carries a seniority keyword", () => {
    const parsed = baseParsed({
      experience: [experience({ title: "Software Engineer" })],
    });
    expect(buildJobQuery(parsed).seniority).toBeUndefined();
  });

  it("leaves seniority undefined when none of several titles carries a keyword", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Board Member" }),
        experience({ title: "Advisor" }),
      ],
    });
    expect(buildJobQuery(parsed).seniority).toBeUndefined();
  });

  it("derives Executive for founder/C-suite titles", () => {
    expect(
      buildJobQuery(baseParsed({ experience: [experience({ title: "Co-Founder" })] }))
        .seniority,
    ).toBe("Executive");
    expect(
      buildJobQuery(baseParsed({ experience: [experience({ title: "Founder & CEO" })] }))
        .seniority,
    ).toBe("Executive");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Chief Technology Officer" })] }),
      ).seniority,
    ).toBe("Executive");
    expect(
      buildJobQuery(baseParsed({ experience: [experience({ title: "CTO" })] })).seniority,
    ).toBe("Executive");
  });

  it("derives Executive for 'Chief of Staff', not IC Staff", () => {
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Chief of Staff" })] }),
      ).seniority,
    ).toBe("Executive");
  });

  it("derives VP for VP/SVP/EVP titles, specific-before-general", () => {
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "VP of Engineering" })] }),
      ).seniority,
    ).toBe("VP");
    expect(
      buildJobQuery(
        baseParsed({
          experience: [experience({ title: "Senior Vice President, Product" })],
        }),
      ).seniority,
    ).toBe("VP");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "EVP, Sales" })] }),
      ).seniority,
    ).toBe("VP");
  });

  it("derives Director for Director/Head of titles", () => {
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Director of Engineering" })] }),
      ).seniority,
    ).toBe("Director");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Head of Product" })] }),
      ).seniority,
    ).toBe("Director");
  });

  it("derives Manager for Manager titles", () => {
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Engineering Manager" })] }),
      ).seniority,
    ).toBe("Manager");
  });

  it("canonicalizes and dedupes skills via the shared SKILLS index", () => {
    const parsed = baseParsed({ skills: ["JS", "Javascript", "React.js", "python3"] });
    const query = buildJobQuery(parsed);
    // "JS" and "Javascript" both canonicalize to the same skill id and collapse.
    expect(query.skills).toEqual(["javascript", "react", "python"]);
  });

  it("passes through an unrecognized skill verbatim (title-cased)", () => {
    const parsed = baseParsed({ skills: ["underwater basket weaving"] });
    const query = buildJobQuery(parsed);
    expect(query.skills).toEqual(["Underwater Basket Weaving"]);
  });

  it("caps skills at MAX_SKILLS", () => {
    const parsed = baseParsed({
      skills: [
        "python", "java", "go", "rust", "ruby", "php", "swift",
        "kotlin", "scala", "c", "cpp", "csharp", "haskell",
      ],
    });
    const query = buildJobQuery(parsed);
    expect(query.skills).toHaveLength(MAX_SKILLS);
  });

  it("does not truncate a normal ~12-skill résumé section", () => {
    const parsed = baseParsed({
      skills: [
        "python", "java", "go", "rust", "ruby", "php", "swift",
        "kotlin", "scala", "sql", "html", "css",
      ],
    });
    const query = buildJobQuery(parsed);
    expect(query.skills).toHaveLength(12);
  });

  it("ignores blank/whitespace-only skill entries", () => {
    const parsed = baseParsed({ skills: ["  ", "", "python"] });
    const query = buildJobQuery(parsed);
    expect(query.skills).toEqual(["python"]);
  });

  it("ranks canonical (taxonomy-recognized) skills ahead of unrecognized ones, past the old cap of 5 (#541)", () => {
    // First 5 entries are incidental/unrecognized strings; a coherent AI/ML
    // cluster sits at positions 6-10. Under the OLD unranked cap of 5, the
    // whole cluster would have been truncated away entirely.
    const parsed = baseParsed({
      skills: [
        "team leadership",
        "stakeholder management",
        "public speaking",
        "cross-functional collaboration",
        "mentoring",
        "python",
        "machine learning",
        "pytorch",
        "tensorflow",
        "nlp",
      ],
    });
    const query = buildJobQuery(parsed);
    // The AI/ML cluster (canonical skills) surfaces ahead of the incidental,
    // unrecognized entries that were typed first.
    const aiClusterIndex = query.skills.indexOf("python");
    const incidentalIndex = query.skills.indexOf("Team Leadership");
    expect(aiClusterIndex).toBeGreaterThanOrEqual(0);
    expect(incidentalIndex).toBeGreaterThanOrEqual(0);
    expect(aiClusterIndex).toBeLessThan(incidentalIndex);
    // All 5 canonical AI/ML skills survive the cap.
    expect(query.skills).toEqual(
      expect.arrayContaining([
        "python",
        "machine learning",
        "pytorch",
        "tensorflow",
        "nlp",
      ]),
    );
  });

  it("preserves résumé order within the canonical and unrecognized tiers (stable sort)", () => {
    const parsed = baseParsed({
      skills: ["go", "rust", "underwater basket weaving", "competitive juggling"],
    });
    const query = buildJobQuery(parsed);
    // Canonical tier keeps its own relative order (go before rust)...
    expect(query.skills.indexOf("go")).toBeLessThan(query.skills.indexOf("rust"));
    // ...and the unrecognized tier keeps its own relative order too.
    expect(query.skills.indexOf("Underwater Basket Weaving")).toBeLessThan(
      query.skills.indexOf("Competitive Juggling"),
    );
  });
});

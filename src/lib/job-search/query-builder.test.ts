// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  buildJobQuery,
  splitHeadline,
  roleHeadForSearch,
  MAX_SKILLS,
  MAX_TITLES,
} from "./query-builder.ts";
import { searchPhrase } from "./providers/keywords.ts";
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
      excludeTerms: [],
    });
  });

  it("defaults excludeTerms to [] when no seeds are passed (issue 563)", () => {
    expect(buildJobQuery(baseParsed()).excludeTerms).toEqual([]);
    expect(
      buildJobQuery(baseParsed({ skills: ["Python"] })).excludeTerms,
    ).toEqual([]);
  });

  it("seeds excludeTerms verbatim from the passed seed list (issue 563)", () => {
    const query = buildJobQuery(baseParsed(), ["solutions architect"]);
    expect(query.excludeTerms).toEqual(["solutions architect"]);
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

  it("leaves families undefined when no familySeeds are passed (issue 568)", () => {
    expect(buildJobQuery(baseParsed()).families).toBeUndefined();
    expect(buildJobQuery(baseParsed(), ["solutions architect"]).families).toBeUndefined();
  });

  it("seeds families verbatim from the passed seed list, even an empty one (issue 568)", () => {
    expect(buildJobQuery(baseParsed(), [], ["backend"]).families).toEqual(["backend"]);
    // An explicit empty array is a real "user removed every chip" assertion,
    // distinct from the undefined "never asserted" default above.
    expect(buildJobQuery(baseParsed(), [], []).families).toEqual([]);
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

  it("annotates which of the emitted skills are canonical names, and only those", () => {
    // The fact `term-quality.ts` cannot recover on its own: a title-cased
    // free-text phrase is indistinguishable from a canonical label downstream,
    // and judging one as the other is what marked real skills weak.
    const parsed = baseParsed({
      skills: ["JS", "Team Building & Mentorship", "python3", "Competitive Juggling"],
    });
    const query = buildJobQuery(parsed);
    expect(query.skills).toEqual([
      "javascript",
      "python",
      "Team Building & Mentorship",
      "Competitive Juggling",
    ]);
    expect(query.canonicalSkills).toEqual(["javascript", "python"]);
  });

  it("leaves canonicalSkills absent when no skill is a canonical name", () => {
    // Absent means "not asserted", which readers treat as no standing to judge —
    // never as "none are canonical, so all are weak". "Engineering Leadership"
    // used to be the example here and stopped working as one: #594 made it an
    // alias of `people-management`, which is the whole point of that change.
    const query = buildJobQuery(baseParsed({ skills: ["Underwater Basket Weaving"] }));
    expect(query.canonicalSkills).toBeUndefined();
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
    // The first 5 entries are typed first but are NOT uniformly incidental any
    // more: #583 made "stakeholder management" and "cross-functional
    // collaboration" canonical, while "team leadership", "public speaking" and
    // "mentoring" stay unrecognized. A coherent AI/ML cluster sits at positions
    // 6-10. Under the OLD unranked cap of 5, the whole cluster would have been
    // truncated away entirely. What this asserts is the surviving property:
    // canonical outranks non-canonical regardless of input order.
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
    // Pin the #583 canonicality: the leadership skill the taxonomy now
    // recognizes leads the ranked list, ahead of the AI/ML cluster.
    // The canonical label verbatim — title-cased in the dictionary since #607,
    // so a recognized skill no longer renders lowercase beside a title-cased
    // free-text one.
    expect(query.skills[0]).toBe("Stakeholder Management");
    const aiClusterIndex = query.skills.indexOf("python");
    const incidentalIndex = query.skills.indexOf("Team Leadership");
    expect(aiClusterIndex).toBeGreaterThanOrEqual(0);
    expect(incidentalIndex).toBeGreaterThanOrEqual(0);
    expect(aiClusterIndex).toBeLessThan(incidentalIndex);
    // All 5 canonical AI/ML skills survive the cap.
    expect(query.skills).toEqual(
      expect.arrayContaining([
        "python",
        "Machine Learning",
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

  it("ranks leadership-competency skills as canonical, not just tool skills (#583)", () => {
    // Before #583, every entry in a leadership résumé's skill list was
    // non-canonical, so `isCanonical` tied across the board and the
    // canonical-first sort collapsed to a no-op (résumé order only).
    const parsed = baseParsed({
      skills: [
        "public speaking",
        "people management",
        "led hiring",
        "owned the roadmap",
        "cross-functional collaboration",
      ],
    });
    const query = buildJobQuery(parsed);
    // The leadership competencies now resolve to canonical labels...
    expect(query.skills).toEqual(
      expect.arrayContaining([
        "People Management",
        "Technical Recruiting",
        "Roadmap Ownership",
        "Cross-Functional Collaboration",
      ]),
    );
    // ...and rank ahead of the one entry that still has no canonical match,
    // proving the sort is no longer a tie.
    const firstCanonicalIndex = query.skills.indexOf("People Management");
    const incidentalIndex = query.skills.indexOf("Public Speaking");
    expect(firstCanonicalIndex).toBeGreaterThanOrEqual(0);
    expect(incidentalIndex).toBeGreaterThanOrEqual(0);
    expect(firstCanonicalIndex).toBeLessThan(incidentalIndex);
  });
});

describe("buildJobQuery titleNoise (issue 579)", () => {
  it("derives it from experience LOCATIONS and COMPANY names", () => {
    const query = buildJobQuery(
      baseParsed({
        experience: [
          experience({
            title: "Berlin Site Lead",
            company: "Globex Holdings",
            location: "Berlin, Germany",
          }),
        ],
      }),
    );
    // Both surfaces contribute, tokenized the same way the title scorer
    // tokenizes query titles (>2 chars, lowercased).
    expect(query.titleNoise).toEqual(
      expect.arrayContaining(["berlin", "germany", "globex", "holdings"]),
    );
  });

  it("unions across every experience row and dedupes", () => {
    const query = buildJobQuery(
      baseParsed({
        experience: [
          experience({ company: "Globex", location: "Berlin, Germany" }),
          experience({ company: "Globex", location: "Munich, Germany" }),
        ],
      }),
    );
    expect(query.titleNoise).toEqual(["berlin", "germany", "globex", "munich"]);
  });

  it("is ABSENT when experience carries neither a location nor a company", () => {
    // No experience at all.
    expect(buildJobQuery(baseParsed()).titleNoise).toBeUndefined();
    // Experience rows with an empty company and no location.
    expect(
      buildJobQuery(
        baseParsed({
          experience: [{ title: "Software Engineer", company: "" }],
        }),
      ).titleNoise,
    ).toBeUndefined();
  });

  it("drops sub-3-char tokens, matching the title scorer's tokenizer", () => {
    const query = buildJobQuery(
      baseParsed({ experience: [experience({ company: "IBM", location: "Austin, TX" })] }),
    );
    // "ibm" survives (3 chars); "tx" does not (2).
    expect(query.titleNoise).toEqual(["austin", "ibm"]);
  });

  it("GUARD RAIL: never adds a token that is in the ROLE_KEYWORDS vocabulary", () => {
    const query = buildJobQuery(
      baseParsed({
        experience: [experience({ title: "Design Lead", company: "Design Studio" })],
      }),
    );
    // `design` is real role vocabulary (ROLE_KEYWORDS.design carries "design
    // lead" / "visual design"), so it must stay a query term even though it is
    // literally part of this employer's name. Only `studio` is noise.
    expect(query.titleNoise).toEqual(["studio"]);
  });

  it("GUARD RAIL: keeps a role word that is also the employer's name, on a title whose only other word is below the token gate", () => {
    const query = buildJobQuery(
      baseParsed({
        experience: [experience({ title: "VP Engineering", company: "Engineering Inc." })],
      }),
    );
    // `engineering` is an exact member of the flattened vocabulary (from
    // "engineering manager" / "engineering lead" / …). Without the guard rail it
    // would be suppressed as employer noise, stripping the ONLY scoring word
    // this title has — "vp" is below the 3-char token gate.
    expect(query.titleNoise).not.toContain("engineering");
    expect(query.titleNoise).toEqual(["inc."]);
  });

  // The membership test is EXACT, not prefix. This is the case that separates
  // the two: none of these employer/place tokens is in the vocabulary, but each
  // STARTS with one that is (`data`, `sales`, `seo`). A prefix guard would
  // protect all three and leave them scoring as query terms — precisely the
  // employer/geography bleed #579 exists to suppress.
  it("GUARD RAIL: does NOT protect an employer or place token that merely starts with a vocabulary token", () => {
    const query = buildJobQuery(
      baseParsed({
        experience: [
          experience({ title: "Data Engineer", company: "Datadog", location: "Seoul" }),
          experience({ title: "Data Engineer", company: "Salesforce", location: "Seattle" }),
        ],
      }),
    );
    expect(query.titleNoise).toContain("datadog");
    expect(query.titleNoise).toContain("seoul");
    expect(query.titleNoise).toContain("salesforce");
  });

  // ── The stated target (#599) and the audited egress (#605 review) ──────────
  //
  // `titles[0]` is not just a display slot: `providers/keywords.ts` sends it
  // verbatim as the keyless feeds' `search=` param — the single resume-derived
  // egress in the app. So what lands at index 0 is a privacy-surface decision,
  // and these assert it through `searchPhrase` rather than through `titles`
  // alone, so a change to that mapping cannot pass them silently.

  it("leads titles with the stated target so it becomes the egress phrase", () => {
    const query = buildJobQuery(
      baseParsed({
        headline: "Platform Engineer",
        experience: [experience({ title: "Software Engineer" })],
      }),
    );
    expect(query.titles[0]).toBe("Platform Engineer");
    expect(searchPhrase(query)).toBe("Platform Engineer");
  });

  // A headline is a tagline, not a title: `extractHeadline` routinely lifts
  // "DevOps Engineer · Software Architect" off a real résumé. Sent whole it is
  // a single-intent full-text query naming two intents — exactly what
  // `keywords.ts`'s docblock says it avoids — and it returns near-nothing.
  it("splits a separator-stacked headline so only ONE role reaches the feeds", () => {
    const query = buildJobQuery(
      baseParsed({
        headline: "DevOps Engineer · Software Architect",
        experience: [experience({ title: "Site Reliability Engineer" })],
      }),
    );
    expect(query.titles[0]).toBe("DevOps Engineer");
    expect(searchPhrase(query)).toBe("DevOps Engineer");
    expect(searchPhrase(query)).not.toContain("·");
    // The second role is not discarded — it still widens the LOCAL
    // `matchesQuery` broadening, it just never leaves the browser.
    expect(query.titles).toContain("Software Architect");
    expect(query.titles).toContain("Site Reliability Engineer");
  });

  // The split must not manufacture the egress phrase. Before the space guard,
  // "React/Node Engineer" left the browser as "React" and "VP, Engineering" as
  // "VP" — a term the user never held, and one `looksLikeTitle` would have
  // rejected outright had anything re-checked the parts (#605 review).
  it.each([
    "React/Node Engineer",
    "VP, Engineering",
    "Engineer, Data Platform",
  ])("egresses %s whole, not a fragment of it", (headline) => {
    const query = buildJobQuery(
      baseParsed({
        headline,
        experience: [experience({ title: "Software Engineer" })],
      }),
    );
    expect(query.titles[0]).toBe(headline);
    expect(searchPhrase(query)).toBe(headline);
  });

  it("keeps the split titles within MAX_TITLES", () => {
    const query = buildJobQuery(
      baseParsed({
        headline: "Engineer / Architect / Manager",
        experience: [
          experience({ title: "Staff Engineer" }),
          experience({ title: "Principal Engineer" }),
          experience({ title: "Director of Engineering" }),
        ],
      }),
    );
    expect(query.titles.length).toBeLessThanOrEqual(MAX_TITLES);
  });

  it("does not duplicate a headline that repeats an experience title", () => {
    const query = buildJobQuery(
      baseParsed({
        headline: "Software Engineer",
        experience: [experience({ title: "Software Engineer" })],
      }),
    );
    expect(query.titles).toEqual(["Software Engineer"]);
  });

  describe("roleHeadForSearch", () => {
    it("drops a trailing scope qualifier after a spaced dash", () => {
      expect(roleHeadForSearch("Engineering Lead - Customer Experience")).toBe(
        "Engineering Lead",
      );
      expect(roleHeadForSearch("Head of Engineering — EMEA")).toBe("Head of Engineering");
    });

    it("picks the part that reads as a role, not blindly the first (#605 re-gate)", () => {
      // The qualifier leads here. `looksLikeTitle` rejects it, so the head is
      // the second part — a blind `parts[0]` would search "Customer Experience".
      expect(roleHeadForSearch("Customer Experience - Engineering Lead")).toBe(
        "Engineering Lead",
      );
    });

    it("keeps a single role whole when its punctuation is NOT a role stack (#605)", () => {
      // These are the two shapes that made an unguarded splitter egress a
      // fragment. The comma is not in the separator set at all, and `/` splits
      // only when spaced — so both survive intact.
      expect(roleHeadForSearch("VP, Engineering")).toBe("VP, Engineering");
      expect(roleHeadForSearch("React/Node Engineer")).toBe("React/Node Engineer");
      expect(roleHeadForSearch("Engineer, Data Platform")).toBe("Engineer, Data Platform");
    });

    it("keeps the whole string when NO part reads as a title", () => {
      expect(roleHeadForSearch("Coffee Lover · Dog Dad")).toBe("Coffee Lover · Dog Dad");
    });

    it("returns a separator-free title unchanged, so callers can apply it always", () => {
      expect(roleHeadForSearch("Sr. Engineering Manager")).toBe("Sr. Engineering Manager");
      expect(roleHeadForSearch("  Staff Engineer  ")).toBe("Staff Engineer");
    });
  });

  describe("splitHeadline", () => {
    it("returns a single entry for a plain headline", () => {
      expect(splitHeadline("Engineering Lead")).toEqual(["Engineering Lead"]);
    });

    it("splits on every stacking separator and trims the parts", () => {
      expect(
        splitHeadline("Engineer · Architect | Consultant / Manager - Director"),
      ).toEqual([
        "Engineer",
        "Architect",
        "Consultant",
        "Manager",
        "Director",
      ]);
    });

    // `titles[0]` is what `keywords.ts` sends verbatim as the feeds' `search=`
    // param, so an unguarded `/` or `,` does not merely mis-chip — it egresses
    // "React" or "VP" in place of the role the user actually holds (#605
    // review). Both characters appear INSIDE a single role far more often than
    // they stack two.
    it("does NOT split a single role on an unspaced / or on a comma", () => {
      expect(splitHeadline("React/Node Engineer")).toEqual([
        "React/Node Engineer",
      ]);
      expect(splitHeadline("VP, Engineering")).toEqual(["VP, Engineering"]);
      expect(splitHeadline("Engineer, Data Platform")).toEqual([
        "Engineer, Data Platform",
      ]);
      // A genuinely stacked pair still splits — the space is the signal.
      expect(splitHeadline("Product Manager / Data Analyst")).toEqual([
        "Product Manager",
        "Data Analyst",
      ]);
    });

    // The shape gates upstream run on the COMPOUND; the split invents parts
    // nothing has checked. `looksLikeTitle("Software Engineer · Coffee Lover")`
    // is true, `looksLikeTitle("Coffee Lover")` is not.
    it("drops a manufactured part that does not read as a title", () => {
      expect(splitHeadline("Software Engineer · Coffee Lover")).toEqual([
        "Software Engineer",
      ]);
      expect(splitHeadline("Engineer | Globex Labs")).toEqual(["Engineer"]);
    });

    it("keeps the whole headline when NO part reads as a title", () => {
      expect(splitHeadline("Coffee Lover · Dog Dad")).toEqual([
        "Coffee Lover · Dog Dad",
      ]);
    });

    // "&"/"and" join ONE compound role ("Founding Member & Site Reliability
    // Engineer"), so splitting on them would mint titles nobody holds.
    it("does NOT split a compound role joined by & or a hyphenated word", () => {
      expect(splitHeadline("Founding Member & Site Reliability Engineer")).toEqual([
        "Founding Member & Site Reliability Engineer",
      ]);
      expect(splitHeadline("Full-Stack Engineer")).toEqual(["Full-Stack Engineer"]);
    });

    it("is empty for absent or blank input, and drops empty parts", () => {
      expect(splitHeadline(undefined)).toEqual([]);
      expect(splitHeadline("   ")).toEqual([]);
      expect(splitHeadline("Engineer ·  · Architect")).toEqual([
        "Engineer",
        "Architect",
      ]);
    });
  });
});

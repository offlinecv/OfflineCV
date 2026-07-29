// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  assessQueryTerms,
  MAX_MISSING_SKILLS,
  TERM_QUALITY_VERSION,
} from "./term-quality.ts";
import type { TermVerdict } from "./term-quality.ts";
import { buildJobQuery } from "./query-builder.ts";
import type { JobQuery } from "./query-builder.ts";
import { roleProfileById } from "./role-profiles.ts";

/** Minimal typed query stub — only the fields the classifier reads. */
function makeQuery(overrides: Partial<JobQuery> = {}): JobQuery {
  return { titles: [], skills: [], ...overrides };
}

function verdictFor(verdicts: readonly TermVerdict[], term: string): TermVerdict | undefined {
  return verdicts.find((verdict) => verdict.term === term);
}

function qualityOf(verdicts: readonly TermVerdict[], term: string): string | undefined {
  return verdictFor(verdicts, term)?.quality;
}

describe("assessQueryTerms — totality", () => {
  it("is versioned", () => {
    expect(TERM_QUALITY_VERSION).toBe("1.2");
  });

  it("returns empty results for an empty query", () => {
    expect(assessQueryTerms(makeQuery())).toEqual({ verdicts: [], missing: [] });
  });

  it("does not throw on a query missing every optional field", () => {
    // A hand-built or storage-restored query, the shape the type does not stop.
    expect(() => assessQueryTerms({} as JobQuery)).not.toThrow();
    expect(assessQueryTerms({} as JobQuery)).toEqual({ verdicts: [], missing: [] });
  });

  it("drops blank and non-string chips instead of judging them", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager", "   "],
        skills: [null as unknown as string, "People Management"],
      }),
    );
    expect(verdicts.map((verdict) => verdict.term)).toEqual([
      "Engineering Manager",
      "People Management",
    ]);
  });

  it("emits one verdict per distinct term, case-insensitively", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager", "engineering manager"] }),
    );
    expect(verdicts).toHaveLength(1);
  });

  it("is deterministic across calls", () => {
    const query = makeQuery({
      titles: ["Engineering Manager", "Acme Berlin"],
      skills: ["People Management", "Go", "Photoshop"],
      titleNoise: ["Acme", "Berlin"],
    });
    expect(assessQueryTerms(query)).toEqual(assessQueryTerms(query));
  });
});

describe("assessQueryTerms — noise", () => {
  it("marks a title whose every word is the résumé's own geography or employer", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Acme Berlin"], titleNoise: ["Acme Corp.", "Berlin"] }),
    );
    const verdict = verdictFor(verdicts, "Acme Berlin");
    expect(verdict?.quality).toBe("noise");
    expect(verdict?.reason).toMatch(/place or an employer/);
  });

  it("keeps a title that carries a real role word alongside a noise word", () => {
    // "Berlin Site Lead" still admits on `site`/`lead` — only `berlin` is noise,
    // so the title as a whole is not.
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Berlin Site Lead"], titleNoise: ["Berlin"] }),
    );
    // Asserted as the exact quality, not `not.toBe("noise")` — an unjudged term
    // has no verdict at all, so the negative form would pass vacuously.
    expect(qualityOf(verdicts, "Berlin Site Lead")).toBe("strong");
  });

  it("gives a different reason for a title with no searchable word at all", () => {
    const { verdicts } = assessQueryTerms(makeQuery({ titles: ["IC 3"] }));
    const verdict = verdictFor(verdicts, "IC 3");
    expect(verdict?.quality).toBe("noise");
    expect(verdict?.reason).not.toMatch(/place or an employer/);
  });

  it("marks a skill below the significance gate", () => {
    const { verdicts } = assessQueryTerms(makeQuery({ skills: ["Go", "AI"] }));
    expect(qualityOf(verdicts, "Go")).toBe("noise");
    expect(qualityOf(verdicts, "AI")).toBe("noise");
  });

  it("keeps a short symbol-bearing skill out of noise", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({
        titles: ["Backend Engineer"],
        skills: ["C#"],
        // Canonical, so the classifier has standing to call it off-role — see
        // the "weak needs standing" test below for what happens without it.
        canonicalSkills: ["C#"],
      }),
    );
    expect(qualityOf(verdicts, "C#")).toBe("weak");
  });

  it("reports noise ahead of strong for a term that cannot narrow anything", () => {
    // `go` IS canonical for the resolved backend role and still admits nothing.
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Backend Engineer"], skills: ["Go", "PostgreSQL"] }),
    );
    expect(qualityOf(verdicts, "Go")).toBe("noise");
    expect(qualityOf(verdicts, "PostgreSQL")).toBe("strong");
  });

  it("judges noise without any resolved role, since noise does not depend on one", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Acme Berlin"], titleNoise: ["Acme", "Berlin"] }),
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].quality).toBe("noise");
  });
});

describe("assessQueryTerms — strong and weak", () => {
  it("marks a title the resolved role is actually called", () => {
    const { verdicts } = assessQueryTerms(makeQuery({ titles: ["Engineering Manager"] }));
    expect(qualityOf(verdicts, "Engineering Manager")).toBe("strong");
  });

  it("tolerates decoration on the résumé side of a strong title", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Senior Engineering Manager, Payments"] }),
    );
    expect(qualityOf(verdicts, "Senior Engineering Manager, Payments")).toBe("strong");
  });

  it("marks a recognized but off-role title weak", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager", "Chief Happiness Officer"] }),
    );
    expect(qualityOf(verdicts, "Engineering Manager")).toBe("strong");
    expect(qualityOf(verdicts, "Chief Happiness Officer")).toBe("weak");
  });

  it("marks a skill the resolved role is described with", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager"], skills: ["People Management"] }),
    );
    expect(qualityOf(verdicts, "People Management")).toBe("strong");
  });

  it("marks a lone off-role tool weak", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["Figma", "Tableau"],
        canonicalSkills: ["Figma", "Tableau"],
      }),
    );
    expect(qualityOf(verdicts, "Figma")).toBe("weak");
    expect(qualityOf(verdicts, "Tableau")).toBe("weak");
  });

  it("reads a coherent off-role cluster as a real second facet, not as weak", () => {
    // The failure this guards: judging an EM's ML stack against the manager
    // profile alone would call three sharp, narrowing terms worthless.
    const { verdicts } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["People Management", "Python", "PyTorch", "TensorFlow"],
      }),
    );
    expect(qualityOf(verdicts, "People Management")).toBe("strong");
    expect(qualityOf(verdicts, "PyTorch")).toBe("strong");
    expect(qualityOf(verdicts, "TensorFlow")).toBe("strong");
  });

  it("compares skills case- and separator-insensitively", () => {
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Site Reliability Engineer"], skills: ["CI/CD", "kubernetes"] }),
    );
    expect(qualityOf(verdicts, "CI/CD")).toBe("strong");
    expect(qualityOf(verdicts, "kubernetes")).toBe("strong");
  });
});

/**
 * The manual-testing reproduction that motivated the standing rule, verbatim: a
 * real leadership résumé whose role resolved CONFIDENTLY (engineering-manager,
 * senior-engineering-manager, founder-ceo) and which was then told that nine of
 * its eleven skills — "Engineering Leadership", "Team Building & Mentorship",
 * "Hiring & Talent Acquisition" among them — are "not what this role is usually
 * hired on". That is the one thing `term-quality.ts` exists not to do.
 */
describe("assessQueryTerms — a free-text skill is never called weak", () => {
  const LEADERSHIP_SKILLS = [
    "cross-functional collaboration",
    "Engineering Leadership",
    "Technical Architecture & System Design",
    "Distributed Systems & Cloud Computing",
    "Team Building & Mentorship",
    "Hiring & Talent Acquisition",
    "Product Development & Strategy",
    "Performance Optimization",
    "AI",
    "LLM Orchestration",
    "Prompt Engineering & Evals",
  ];
  const leadership = makeQuery({
    titles: ["Engineering Lead", "Founder & CEO", "India Lead", "Sr. Engineering Manager"],
    skills: LEADERSHIP_SKILLS,
    // What `buildJobQuery` ships for this résumé: exactly one of the eleven
    // phrases is a canonical skill name. `query-builder.test.ts` pins that.
    canonicalSkills: ["cross-functional collaboration"],
  });

  it("marks no skill of the reproduction weak", () => {
    const { verdicts } = assessQueryTerms(leadership);
    const weak = verdicts.filter((v) => v.kind === "skill" && v.quality === "weak");
    expect(weak).toEqual([]);
  });

  it("says nothing at all about a phrase it has no canonical name for", () => {
    const { verdicts } = assessQueryTerms(leadership);
    expect(verdictFor(verdicts, "Engineering Leadership")).toBeUndefined();
    expect(verdictFor(verdicts, "Hiring & Talent Acquisition")).toBeUndefined();
  });

  it("still marks the canonical skill strong, and reads a multi-concept phrase that names an expected skill", () => {
    const { verdicts } = assessQueryTerms(leadership);
    expect(qualityOf(verdicts, "cross-functional collaboration")).toBe("strong");
    // "Team Building & Mentorship" names `team-building`, which this role expects.
    expect(qualityOf(verdicts, "Team Building & Mentorship")).toBe("strong");
  });

  it("keeps the role-independent noise verdict, which does not need standing", () => {
    expect(qualityOf(assessQueryTerms(leadership).verdicts, "AI")).toBe("noise");
  });

  it("withholds every skill verdict when canonicality is not asserted at all", () => {
    // A hand-built or storage-restored query. Absent data is read as "no
    // standing", never as "nothing is canonical, so everything is weak".
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager"], skills: ["Figma", "Tableau"] }),
    );
    expect(verdicts.filter((v) => v.kind === "skill")).toEqual([]);
  });

  it("does not manufacture a strong verdict from a merely shared qualifier", () => {
    // "Performance Optimization" and `performance-management` share
    // "performance" and disagree on the head noun — different skills.
    const { verdicts } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["Performance Optimization"],
        canonicalSkills: [],
      }),
    );
    expect(verdictFor(verdicts, "Performance Optimization")).toBeUndefined();
  });

  it("does not manufacture a strong verdict from a bare head noun", () => {
    // A less-qualified form suppresses a SUGGESTION but is not evidence for a
    // verdict — "Strategy" is not "technical strategy".
    const { verdicts } = assessQueryTerms(
      makeQuery({ titles: ["CTO"], skills: ["Strategy"], canonicalSkills: [] }),
    );
    expect(verdictFor(verdicts, "Strategy")).toBeUndefined();
  });

  it("never matches a skill on a substring of a word", () => {
    // `java` must not be read out of "JavaScript", nor `sql` out of "MySQL".
    const { verdicts } = assessQueryTerms(
      makeQuery({
        titles: ["Backend Engineer"],
        skills: ["JavaScript", "MySQL"],
        canonicalSkills: ["JavaScript", "MySQL"],
      }),
    );
    expect(qualityOf(verdicts, "JavaScript")).toBe("weak");
    expect(qualityOf(verdicts, "MySQL")).toBe("weak");
  });
});

describe("assessQueryTerms — unresolved role", () => {
  const unresolved = makeQuery({
    titles: ["Chief Happiness Officer"],
    skills: ["Excel", "Go"],
  });

  it("returns no missing terms", () => {
    expect(assessQueryTerms(unresolved).missing).toEqual([]);
  });

  it("marks nothing weak on the basis of a role it could not identify", () => {
    const { verdicts } = assessQueryTerms(unresolved);
    expect(verdicts.every((verdict) => verdict.quality !== "weak")).toBe(true);
  });

  it("returns no verdict at all for a term it cannot judge", () => {
    const { verdicts } = assessQueryTerms(unresolved);
    expect(verdictFor(verdicts, "Chief Happiness Officer")).toBeUndefined();
    expect(verdictFor(verdicts, "Excel")).toBeUndefined();
    // …while the role-independent verdict still lands.
    expect(qualityOf(verdicts, "Go")).toBe("noise");
  });
});

describe("assessQueryTerms — missing terms", () => {
  it("names titles and skills the resolved role expects and the résumé lacks", () => {
    const { missing } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager"], skills: ["People Management"] }),
    );
    const titles = missing.filter((entry) => entry.kind === "title").map((e) => e.term);
    const skills = missing.filter((entry) => entry.kind === "skill").map((e) => e.term);
    expect(titles).toContain("engineering team lead");
    // Not asserted by naming one skill: since #588 the head of
    // `RoleProfile.skills` is prevalence-ranked from a regenerable snapshot, and
    // `MAX_MISSING_SKILLS` keeps only that head — so naming a single expected
    // term would fail on a mining run that reordered it, for no behavioural
    // reason.
    //
    // Asserted instead as a PREFIX, which is ordering-insensitive in the same
    // way but is NOT satisfied by an arbitrary subset: the suggestions must be
    // the profile's own leading skills, in the profile's own order, minus only
    // the ones the query already carries. That pins the thing the cap actually
    // promises — that it keeps the HEAD — so a change that made the cap sample
    // from the tail fails here.
    //
    // It does NOT pin that the prevalence ordering reaches this module: both
    // sides read `roleProfileById`, so they move together. (Concretely:
    // `engineering-manager`'s skill axis is `thin-observations`, so its shipped
    // order IS its curated order.) The ordering's arrival is covered where it
    // belongs, in `role-profiles.test.ts`.
    const expected = roleProfileById("engineering-manager")?.skills ?? [];
    expect(skills.length).toBeGreaterThan(0);
    const covered = new Set(["people-management"]);
    const wanted = expected.filter((s) => !covered.has(s)).slice(0, MAX_MISSING_SKILLS);
    expect(skills).toEqual(wanted);
    expect(skills).not.toContain("people-management");
  });

  it("never names a term the résumé already carries", () => {
    const { missing } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager"], skills: ["People Management"] }),
    );
    expect(missing.map((entry) => entry.term)).not.toContain("engineering manager");
    expect(missing.map((entry) => entry.term)).not.toContain("people-management");
  });

  it("counts a decorated résumé title as already covering the expected one", () => {
    const { missing } = assessQueryTerms(
      makeQuery({ titles: ["Senior Software Engineering Manager"] }),
    );
    expect(missing.map((entry) => entry.term)).not.toContain("senior engineering manager");
  });

  it("caps each kind so the advice stays readable", () => {
    const { missing } = assessQueryTerms(makeQuery({ titles: ["Frontend Engineer"] }));
    expect(missing.filter((entry) => entry.kind === "title").length).toBeLessThanOrEqual(3);
    expect(missing.filter((entry) => entry.kind === "skill").length).toBeLessThanOrEqual(5);
  });

  it("never suggests a term it would itself mark noise", () => {
    // `go` is canonical for the backend role and cannot narrow a search, so the
    // advice must skip it and back-fill from the next expected skill.
    const { missing } = assessQueryTerms(makeQuery({ titles: ["Backend Engineer"] }));
    const skills = missing.filter((entry) => entry.kind === "skill").map((e) => e.term);
    expect(skills).not.toContain("go");
    expect(skills).toHaveLength(5);
  });

  it("never suggests a skill the query already says in different words", () => {
    // The second half of the reproduction: "+ team building" was offered while
    // "Team Building & Mentorship" sat as a chip on the same screen, and
    // "+ coaching / mentorship" beside it.
    const { missing } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Lead", "Sr. Engineering Manager"],
        skills: ["Team Building & Mentorship", "Hiring & Talent Acquisition"],
      }),
    );
    const skills = missing.filter((entry) => entry.kind === "skill").map((e) => e.term);
    expect(skills).not.toContain("team-building");
    expect(skills).not.toContain("coaching-mentorship");
    // Suppression costs the advice nothing: the cap back-fills from the next
    // most-expected entry, so the row is still full.
    expect(skills).toHaveLength(5);
  });

  it("still suggests a skill that only shares a qualifier with one the query has", () => {
    // The over-suppression guard. The reproduction was "Performance
    // Optimization" against the expected `performance-management`: a shared
    // qualifier word is not the same skill, and suppressing on it hides a real
    // gap. Asserted here on the SAME relation but through `account-executive`,
    // whose curated skill list is exactly `MAX_MISSING_SKILLS` long, so nothing
    // can fall out of `missing` via the head-cap. That matters since #588 made
    // the head a function of a regenerable prevalence snapshot: run against a
    // longer profile, this assertion would report the snapshot's ordering
    // instead of the suppression rule, and pass or fail for the wrong reason.
    // The precondition, asserted rather than assumed: a sixth curated skill on
    // `account-executive` would push a term past the head-cap and this test
    // would start reporting the cap instead of the suppression rule — silently,
    // and in whichever direction the snapshot happened to order things.
    expect(roleProfileById("account-executive")?.skills).toHaveLength(
      MAX_MISSING_SKILLS,
    );
    const query = makeQuery({
      titles: ["Account Executive"],
      skills: ["Executive Search"],
    });
    expect(assessQueryTerms(query).missing.map((entry) => entry.term)).toContain(
      "executive-communication",
    );
    // Not vacuous: the query saying the skill FOR REAL does suppress it, so the
    // assertion above is evidence the guard held rather than evidence that
    // nothing is ever suppressed.
    const saidForReal = makeQuery({
      titles: ["Account Executive"],
      skills: ["Executive Communication"],
    });
    expect(
      assessQueryTerms(saidForReal).missing.map((entry) => entry.term),
    ).not.toContain("executive-communication");
  });

  it("still suggests a leadership skill the query only says in a spelling jd-match does not know", () => {
    // The pre-#594 state of the world, pinned so the fix is attributable to the
    // alias data and not to some coincidence downstream: this module compares
    // word-wise and cannot see jd-match's aliases (its docblock forbids the
    // import), so a RAW skills-row phrasing shares no word with the expected id
    // and is correctly — from this module's point of view — not a match.
    // `buildJobQuery` is what makes the end-to-end case below pass, by rewriting
    // the chip to the canonical label first. Delete the alias and that test goes
    // red while this one keeps passing.
    const { missing } = assessQueryTerms(
      makeQuery({
        titles: ["Senior Engineering Manager"],
        skills: ["Hiring & Talent Acquisition", "Engineering Leadership"],
      }),
    );
    const skills = missing.filter((entry) => entry.kind === "skill").map((e) => e.term);
    expect(skills).toContain("technical-recruiting");
    expect(skills).toContain("people-management");
  });

  it("never suggests a wordier spelling of a title the query already carries, but keeps a different market phrasing", () => {
    // The reproduction's titles. "+ engineering team lead" was offered to
    // someone titled "Engineering Lead" — {engineering, lead} ⊂ {engineering,
    // team, lead}, the same phrase padded. Both assertions are load-bearing and
    // must be read together: suppressing on any resemblance would also kill
    // "software engineering manager", which boards really do post and this
    // résumé really does not say.
    const { missing } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Lead", "Founder & CEO", "India Lead", "Sr. Engineering Manager"],
      }),
    );
    const titles = missing.filter((entry) => entry.kind === "title").map((e) => e.term);
    expect(titles).not.toContain("engineering team lead");
    expect(titles).toContain("software engineering manager");
    // The cap is full, so the suppressed entry cost the advice nothing.
    expect(titles).toHaveLength(3);
  });

  it("draws from ONE profile, so it never suggests the rung above", () => {
    const { missing } = assessQueryTerms(makeQuery({ titles: ["Engineering Manager"] }));
    const terms = missing.map((entry) => entry.term);
    expect(terms).not.toContain("director of engineering");
    expect(terms).not.toContain("vp of engineering");
  });

  it("falls back to the skill-implied role when no title resolves", () => {
    const { missing } = assessQueryTerms(
      makeQuery({
        titles: ["Chief Happiness Officer"],
        skills: ["Python", "PyTorch", "TensorFlow"],
      }),
    );
    expect(missing.some((entry) => entry.kind === "title")).toBe(true);
    expect(missing.filter((e) => e.kind === "title").map((e) => e.term)).toContain(
      "machine learning engineer",
    );
  });
});

/**
 * The #594/#607 reproduction, end to end — the only level at which it reproduces.
 *
 * A hand-built `JobQuery` cannot show the fix: this module compares word-wise and
 * may not read jd-match's aliases, so the bridge is `buildJobQuery` canonicalizing
 * "Hiring & Talent Acquisition" to the chip "Technical Recruiting" BEFORE the
 * advice is computed. Both halves of the pipe therefore have to be in the test.
 *
 * Each case asserts `missing` is still `MAX_MISSING_SKILLS` long alongside the
 * `not.toContain`, because suppression back-fills: without that, an assertion
 * passes when the term merely fell off the tail of a re-ordered head-cap, which
 * is exactly the wrong reason.
 */
describe("assessQueryTerms + buildJobQuery — a suggestion the résumé already states (#594, #607)", () => {
  function queryFor(skills: string[], titles = ["Engineering Lead", "Sr. Engineering Manager"]): JobQuery {
    return buildJobQuery({
      skills,
      experience: titles.map((title, i) => ({ title, company: i ? "Globex" : "Acme Corp" })),
    });
  }

  function missingSkills(skills: string[], titles?: string[]): string[] {
    return assessQueryTerms(queryFor(skills, titles))
      .missing.filter((entry) => entry.kind === "skill")
      .map((entry) => entry.term);
  }

  it("does not offer '+ technical recruiting' beside a 'Hiring & Talent Acquisition' chip", () => {
    // Titled into `senior-engineering-manager` on purpose: that is the profile
    // whose prevalence-ranked head CARRIES `technical-recruiting` (asserted
    // below, not assumed), so the term had a place in `missing` to lose. Run
    // against `engineering-manager` this would pass whether the fix exists or
    // not, because the term never reaches the head-cap there.
    const titles = ["Senior Engineering Manager"];
    const head = (roleProfileById("senior-engineering-manager")?.skills ?? []).slice(
      0,
      MAX_MISSING_SKILLS,
    );
    expect(head).toContain("technical-recruiting");
    expect(missingSkills([], titles)).toContain("technical-recruiting");

    const skills = missingSkills(["Hiring & Talent Acquisition"], titles);
    expect(skills).not.toContain("technical-recruiting");
    expect(skills).toHaveLength(MAX_MISSING_SKILLS);
  });

  it("does not offer '+ people management' beside an 'Engineering Leadership' chip", () => {
    // On its own, so the suppression cannot be riding on "Team Building &
    // Mentorship" happening to sit in the same query. Same non-vacuity check:
    // the same résumé without that chip IS told to add the skill.
    expect(missingSkills([])).toContain("people-management");
    const skills = missingSkills(["Engineering Leadership"]);
    expect(skills).not.toContain("people-management");
    expect(skills).toHaveLength(MAX_MISSING_SKILLS);
  });

  it("suppresses both across the full reproduction résumé, and still fills the row", () => {
    const skills = missingSkills([
      "Engineering Leadership",
      "Technical Architecture & System Design",
      "Distributed Systems & Cloud Computing",
      "Team Building & Mentorship",
      "Hiring & Talent Acquisition",
      "Cross-functional Collaboration",
      "Product Development & Strategy",
      "Performance Optimization",
      "AI / LLM Orchestration",
      "Prompt Engineering & Evals",
    ]);
    // Not asserted for `technical-recruiting`: these titles resolve to
    // `engineering-manager`, whose head-cap never reaches it, so the assertion
    // would pass without the fix. It is asserted where it bites, above.
    expect(skills).not.toContain("people-management");
    expect(skills).not.toContain("team-building");
    expect(skills).not.toContain("cross-functional-collaboration");
    expect(skills).toHaveLength(MAX_MISSING_SKILLS);
    // The advice that WAS right stays right: that résumé never says agile,
    // scrum, or sprints, and "Performance Optimization" is latency work, not
    // performance management.
    expect(skills).toContain("agile-leadership");
    expect(skills).toContain("performance-management");
  });

  it("never lets a recognized leadership chip read weak", () => {
    // The #585 standing rule, re-asserted on the chips canonicalization now
    // produces: recognition must upgrade a verdict, never manufacture a "this is
    // not what the role is hired on" about a skill the role plainly expects.
    const query = queryFor(["Engineering Leadership", "Hiring & Talent Acquisition"]);
    const { verdicts } = assessQueryTerms(query);
    expect(verdicts.filter((v) => v.kind === "skill" && v.quality === "weak")).toEqual([]);
    expect(qualityOf(verdicts, "People Management")).toBe("strong");
    expect(qualityOf(verdicts, "Technical Recruiting")).toBe("strong");
  });
});

/**
 * Coverage for the title/skill coherence check (issue 587). The failure mode
 * this guards is a FALSE POSITIVE — telling someone their résumé is broken when
 * it isn't — so the silence cases outnumber the firing ones on purpose, and
 * every one of them is a résumé shape a real person has.
 */
describe("assessQueryTerms — title/skill coherence", () => {
  // ── Fires ────────────────────────────────────────────────────────────────

  it("reports leadership titles backed by exclusively hands-on technical skills", () => {
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["Java", "Python", "Kubernetes", "Docker", "Terraform", "AWS"],
      }),
    );
    expect(coherence?.direction).toBe("leadership-titles-ic-skills");
    // Names the user's own title, the skill shape, and what would close the gap.
    expect(coherence?.titles).toEqual(["Engineering Manager"]);
    expect(coherence?.offAxisSkills).toContain("Kubernetes");
    expect(coherence?.missingSkills).toContain("people-management");
    expect(coherence?.note).toContain("Engineering Manager");
  });

  it("reports the inverse — individual-contributor titles backed by exclusively managerial skills", () => {
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Senior Software Engineer"],
        skills: [
          "People Management",
          "Org Design",
          "Budget Headcount Planning",
          "Executive Communication",
          "Performance Management",
        ],
      }),
    );
    expect(coherence?.direction).toBe("ic-titles-leadership-skills");
    expect(coherence?.titles).toEqual(["Senior Software Engineer"]);
    expect(coherence?.offAxisSkills).toContain("Org Design");
    // The competencies the IC titles' own role expects — the other direction.
    expect(coherence?.missingSkills).toContain("python");
  });

  it("names several titles when several resolved", () => {
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Director of Engineering", "Senior Engineering Manager"],
        skills: ["Python", "PyTorch", "TensorFlow", "Machine Learning", "Deep Learning"],
      }),
    );
    expect(coherence?.titles).toEqual(["Director of Engineering", "Senior Engineering Manager"]);
  });

  // ── Stays silent ─────────────────────────────────────────────────────────

  it("stays silent for a senior IC who also lists mentorship skills", () => {
    // THE named false positive. Their skills resolve BOTH an IC role and a
    // manager, so the skill side is mixed — a person who is genuinely both is
    // coherent, not mismatched.
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Senior Software Engineer"],
        skills: ["Python", "Java", "TypeScript", "React", "Coaching Mentorship", "Team Building"],
      }),
    );
    expect(coherence).toBeUndefined();
  });

  it("stays silent for a manager who kept their engineering skills", () => {
    // The multi-facet shape rule 2 protects: an EM who was an ML engineer.
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["People Management", "Coaching Mentorship", "PyTorch", "Python", "Machine Learning"],
      }),
    );
    expect(coherence).toBeUndefined();
  });

  it("stays silent for a promoted IC whose titles span both ladders", () => {
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager", "Senior Software Engineer"],
        skills: ["Java", "Python", "Kubernetes", "Docker", "Terraform"],
      }),
    );
    expect(coherence).toBeUndefined();
  });

  it("stays silent when the titles resolve nothing", () => {
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Zzyzx Wobble Frobnicator"],
        skills: ["Java", "Python", "Kubernetes", "Docker", "Terraform"],
      }),
    );
    expect(coherence).toBeUndefined();
  });

  it("stays silent when the skills resolve nothing", () => {
    const { coherence } = assessQueryTerms(
      makeQuery({ titles: ["Engineering Manager"], skills: ["Photoshop"] }),
    );
    expect(coherence).toBeUndefined();
  });

  it("stays silent when even one skill is what the titles' own role expects", () => {
    // One managerial skill is below the resolver's own two-hit floor, so the
    // axis gate cannot see it — this is the gap the "every" gate closes, and
    // it is what keeps the sentence literally true.
    const { coherence } = assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["Java", "Python", "Kubernetes", "Docker", "Terraform", "Stakeholder Management"],
      }),
    );
    expect(coherence).toBeUndefined();
  });

  it("stays silent on an empty query", () => {
    expect(assessQueryTerms(makeQuery()).coherence).toBeUndefined();
    expect(assessQueryTerms({} as JobQuery).coherence).toBeUndefined();
  });

  // ── The threshold does real work ─────────────────────────────────────────

  it("stays silent below the off-axis skill threshold and reports above it", () => {
    const titles = ["Senior Software Engineer"];
    const marginal = ["Coaching Mentorship", "Team Building"];
    expect(assessQueryTerms(makeQuery({ titles, skills: marginal })).coherence).toBeUndefined();

    const clears = [...marginal, "People Management", "Performance Management"];
    const { coherence } = assessQueryTerms(makeQuery({ titles, skills: clears }));
    expect(coherence?.offAxisSkills).toHaveLength(4);
    expect(coherence?.direction).toBe("ic-titles-leadership-skills");
  });
});

describe("coherence copy", () => {
  const notes = [
    assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager"],
        skills: ["Java", "Python", "Kubernetes", "Docker", "Terraform"],
      }),
    ).coherence?.note,
    assessQueryTerms(
      makeQuery({
        titles: ["Senior Software Engineer"],
        skills: ["People Management", "Org Design", "Team Building", "Performance Management"],
      }),
    ).coherence?.note,
  ];

  it("covers both directions", () => {
    expect(notes.filter(Boolean)).toHaveLength(2);
    expect(new Set(notes).size).toBe(2);
  });

  it("names a consequence, never the mechanism", () => {
    for (const note of notes) {
      expect(note).toBeDefined();
      expect(note).not.toMatch(/tokenizer|filter|regex|gate|profile|resolver|admission|#/i);
    }
  });
});

describe("reason copy", () => {
  // Every reason string the module can emit, gathered from queries that trigger
  // each branch — a denylist over REASONS itself would not prove the branches
  // reach these strings.
  const everyReason = [
    ...assessQueryTerms(
      makeQuery({ titles: ["Acme Berlin", "IC 3"], titleNoise: ["Acme", "Berlin"] }),
    ).verdicts,
    ...assessQueryTerms(
      makeQuery({
        titles: ["Engineering Manager", "Chief Happiness Officer"],
        skills: ["People Management", "Figma", "Go"],
        canonicalSkills: ["People Management", "Figma"],
      }),
    ).verdicts,
  ].map((verdict) => verdict.reason);

  it("covers all seven branches", () => {
    expect(new Set(everyReason).size).toBe(7);
  });

  it("is never empty", () => {
    for (const reason of everyReason) expect(reason.trim().length).toBeGreaterThan(0);
  });

  it("names a consequence, never the mechanism", () => {
    for (const reason of everyReason) {
      expect(reason).not.toMatch(/tokenizer|filter|regex|gate|profile|admission|#/i);
    }
  });
});

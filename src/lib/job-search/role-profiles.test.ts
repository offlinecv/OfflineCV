// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  CURATED_ROLE_PROFILES,
  MAX_FOREIGN_MODAL_TITLE_SHARE,
  MIN_CURATED_HEAD_TITLE_SHARE,
  MIN_PREVALENCE_SAMPLE,
  MIN_PREVALENCE_SKILL_HEAD_COUNT,
  MIN_PREVALENCE_SKILL_OBSERVATIONS,
  ROLE_PROFILES,
  ROLE_PROFILES_VERSION,
  applyPrevalenceOrder,
  auditPrevalence,
  resolveProfilesByTitles,
  resolveProfilesBySkills,
  roleProfileById,
  type RoleProfile,
} from "./role-profiles.ts";
import {
  PREVALENCE_SNAPSHOT,
  type PrevalenceSnapshot,
  type ProfilePrevalence,
} from "./prevalence-snapshot.ts";
import { ROLE_FAMILIES } from "./role-keywords.ts";
import { SENIORITY_LADDER } from "./seniority.ts";
// jd-match is imported by the TEST ONLY — the shipped module keeps the
// skill-id/`SKILLS` join as an asserted invariant rather than a runtime import,
// so no job-search → jd-match dictionary edge is added to the bundle.
import { SKILLS } from "../jd-match/skills.ts";

const KNOWN_SKILL_IDS = new Set(SKILLS.map((entry) => entry.id));
const LADDER_RUNGS = new Set(Object.values(SENIORITY_LADDER));

function familiesOf(profiles: readonly { family: string }[]): string[] {
  return profiles.map((profile) => profile.family);
}

describe("ROLE_PROFILES table integrity", () => {
  it("is versioned", () => {
    expect(ROLE_PROFILES_VERSION).toBe("1.1");
  });

  it("has a unique kebab id per profile", () => {
    const ids = ROLE_PROFILES.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  // The load-bearing anti-drift assertion from #582: the two assets must stay
  // reconcilable, so a profile can never name a family ROLE_KEYWORDS lacks.
  it("declares only real RoleFamily values", () => {
    for (const profile of ROLE_PROFILES) {
      expect(ROLE_FAMILIES).toContain(profile.family);
    }
  });

  it("covers every role family with at least one profile", () => {
    const covered = new Set(familiesOf(ROLE_PROFILES));
    for (const family of ROLE_FAMILIES) {
      expect(covered).toContain(family);
    }
  });

  it("covers the leadership ladder", () => {
    const ids = new Set(ROLE_PROFILES.map((profile) => profile.id));
    for (const id of [
      "engineering-manager",
      "senior-engineering-manager",
      "director-of-engineering",
      "head-of-engineering",
      "vp-engineering",
      "cto",
      "founder-ceo",
      "technical-program-manager",
      "site-lead",
    ]) {
      expect(ids).toContain(id);
    }
  });

  // Guards typos and guarantees the two taxonomies stay joined.
  it("references only skill IDs that resolve against jd-match SKILLS", () => {
    for (const profile of ROLE_PROFILES) {
      for (const skill of profile.skills) {
        expect(KNOWN_SKILL_IDS, `${profile.id} → ${skill}`).toContain(skill);
      }
    }
  });

  it("spans real, ascending seniority rungs", () => {
    for (const profile of ROLE_PROFILES) {
      expect(profile.rungs.length).toBeGreaterThan(0);
      for (const rung of profile.rungs) expect(LADDER_RUNGS).toContain(rung);
      const ascending = [...profile.rungs].sort((a, b) => a - b);
      expect(profile.rungs).toEqual(ascending);
      expect(new Set(profile.rungs).size).toBe(profile.rungs.length);
    }
  });

  it("gives every profile at least one title and one skill", () => {
    for (const profile of ROLE_PROFILES) {
      expect(profile.titles.length).toBeGreaterThan(0);
      expect(profile.skills.length).toBeGreaterThan(0);
      expect(profile.label.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveProfilesByTitles", () => {
  it("resolves a leadership title set to leadership profiles", () => {
    const resolved = resolveProfilesByTitles([
      "Engineering Manager, Payments",
      "Senior Engineering Manager",
    ]);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].id).toBe("engineering-manager");
    expect(new Set(familiesOf(resolved))).toEqual(new Set(["eng-leadership"]));
  });

  it("does NOT resolve an IC title set to a leadership profile", () => {
    const resolved = resolveProfilesByTitles([
      "Senior Software Engineer",
      "Software Engineer",
    ]);
    expect(resolved[0].id).toBe("software-engineer");
    expect(familiesOf(resolved)).not.toContain("eng-leadership");
  });

  it("does not confuse the IC and management ladders (no stemming)", () => {
    // "engineer" and "engineering" stay distinct tokens on purpose.
    expect(
      resolveProfilesByTitles(["Software Engineering Manager"]).map((p) => p.id),
    ).not.toContain("software-engineer");
    expect(
      resolveProfilesByTitles(["Senior Software Engineer"]).map((p) => p.id),
    ).not.toContain("engineering-manager");
  });

  it("does not resolve a sales/GTM title to an eng-leadership profile", () => {
    // The subset rule made bare "development manager" ({development, manager})
    // a subset of "Business Development Manager" ({business, development,
    // manager}), pulling a GTM title onto the engineering ladder. The profile
    // title carries the disambiguating "software" prefix now.
    const resolved = resolveProfilesByTitles(["Business Development Manager"]);
    expect(resolved.map((p) => p.id)).not.toContain("engineering-manager");
    expect(resolved.map((p) => p.family)).not.toContain("eng-leadership");
  });

  it("folds abbreviations — 'Sr. Software Engineer' ≡ 'Senior Software Engineer'", () => {
    expect(resolveProfilesByTitles(["Sr. Software Engineer"])).toEqual(
      resolveProfilesByTitles(["Senior Software Engineer"]),
    );
    expect(resolveProfilesByTitles(["VP of Engineering"])[0].id).toBe("vp-engineering");
    expect(resolveProfilesByTitles(["Vice President, Engineering"])[0].id).toBe(
      "vp-engineering",
    );
    expect(resolveProfilesByTitles(["Chief Technology Officer"])[0].id).toBe("cto");
    expect(resolveProfilesByTitles(["Front-End Developer"])[0].id).toBe("frontend-engineer");
    expect(resolveProfilesByTitles(["SRE"])[0].id).toBe("site-reliability-engineer");
  });

  it("is order-insensitive within a title", () => {
    expect(resolveProfilesByTitles(["Director of Engineering"])[0].id).toBe(
      "director-of-engineering",
    );
    expect(resolveProfilesByTitles(["Engineering Director"])[0].id).toBe(
      "director-of-engineering",
    );
  });

  it("tolerates extra résumé-side words but not missing profile-side ones", () => {
    // The "Berlin Site Lead" shape: geography rides along and is ignored.
    expect(resolveProfilesByTitles(["Berlin Site Lead"])[0].id).toBe("site-lead");
    // A bare "Manager" carries no role signal and must not fabricate one.
    expect(resolveProfilesByTitles(["Manager"])).toEqual([]);
  });

  it("prefers the more specific profile title over the general one", () => {
    const resolved = resolveProfilesByTitles(["Engineering Site Lead"]);
    expect(resolved[0].id).toBe("site-lead");
    expect(resolved.map((p) => p.id)).toContain("engineering-manager");
  });

  it("breaks exact ties on declaration order", () => {
    // Both match one title each at identical specificity and prevalence;
    // "frontend-engineer" is declared before "backend-engineer".
    const resolved = resolveProfilesByTitles(["Backend Engineer", "Frontend Engineer"]);
    expect(resolved.slice(0, 2).map((p) => p.id)).toEqual([
      "frontend-engineer",
      "backend-engineer",
    ]);
  });

  it("returns [] rather than a fabricated match", () => {
    expect(resolveProfilesByTitles(["Chief Happiness Officer"])).toEqual([]);
    expect(resolveProfilesByTitles(["Zamboni Driver"])).toEqual([]);
    expect(resolveProfilesByTitles([])).toEqual([]);
  });

  it("is total over degenerate input", () => {
    const junk = [
      "",
      "   ",
      undefined as unknown as string,
      null as unknown as string,
      "of the and",
    ];
    expect(() => resolveProfilesByTitles(junk)).not.toThrow();
    expect(resolveProfilesByTitles(junk)).toEqual([]);
    expect(() => resolveProfilesByTitles(undefined as unknown as string[])).not.toThrow();
  });

  it("is deterministic across repeated calls", () => {
    const input = ["Senior Engineering Manager", "Software Engineer"];
    expect(resolveProfilesByTitles(input)).toEqual(resolveProfilesByTitles(input));
  });
});

describe("resolveProfilesBySkills", () => {
  it("resolves leadership competencies to leadership profiles", () => {
    const resolved = resolveProfilesBySkills([
      "people-management",
      "performance-management",
      "coaching-mentorship",
    ]);
    expect(resolved[0].id).toBe("engineering-manager");
    expect(new Set(familiesOf(resolved))).toEqual(new Set(["eng-leadership"]));
  });

  it("resolves IC tool skills to IC profiles, never to leadership", () => {
    const resolved = resolveProfilesBySkills(["react", "typescript", "css"]);
    expect(resolved[0].id).toBe("frontend-engineer");
    expect(familiesOf(resolved)).not.toContain("eng-leadership");
  });

  it("accepts display labels as well as ids (case/separator-insensitive)", () => {
    expect(
      resolveProfilesBySkills(["People Management", "Coaching / Mentorship"]).map((p) => p.id),
    ).toEqual(
      resolveProfilesBySkills(["people-management", "coaching-mentorship"]).map((p) => p.id),
    );
  });

  it("needs more than one shared skill — a single hit is a coincidence", () => {
    expect(resolveProfilesBySkills(["python"])).toEqual([]);
    expect(resolveProfilesBySkills(["python", "python", "Python"])).toEqual([]);
  });

  it("returns [] rather than a fabricated match", () => {
    expect(resolveProfilesBySkills(["quidditch", "underwater basket weaving"])).toEqual([]);
    expect(resolveProfilesBySkills([])).toEqual([]);
  });

  it("is total over degenerate input", () => {
    const junk = ["", "   ", undefined as unknown as string, null as unknown as string];
    expect(() => resolveProfilesBySkills(junk)).not.toThrow();
    expect(resolveProfilesBySkills(junk)).toEqual([]);
    expect(() => resolveProfilesBySkills(undefined as unknown as string[])).not.toThrow();
  });

  it("caps the returned tail", () => {
    const everySkill = ROLE_PROFILES.flatMap((profile) => [...profile.skills]);
    expect(resolveProfilesBySkills(everySkill).length).toBeLessThanOrEqual(5);
  });

  it("is deterministic across repeated calls", () => {
    const input = ["people-management", "org-design", "technical-strategy"];
    expect(resolveProfilesBySkills(input)).toEqual(resolveProfilesBySkills(input));
  });
});

describe("the two resolvers are separate questions", () => {
  // The mismatch the asset exists to make visible: leadership titles over an
  // exclusively IC skill list. Neither resolver can see this alone.
  it("surfaces a title/skill disagreement as two different answers", () => {
    const byTitle = resolveProfilesByTitles(["Director of Engineering", "Engineering Manager"]);
    const bySkill = resolveProfilesBySkills(["react", "typescript", "css", "webpack"]);
    expect(byTitle[0].family).toBe("eng-leadership");
    expect(bySkill[0].family).toBe("frontend");
    expect(byTitle[0].id).not.toBe(bySkill[0].id);
  });

  it("agrees when the résumé is coherent", () => {
    const byTitle = resolveProfilesByTitles(["Engineering Manager"]);
    const bySkill = resolveProfilesBySkills([
      "people-management",
      "performance-management",
      "coaching-mentorship",
    ]);
    expect(byTitle[0].id).toBe(bySkill[0].id);
  });
});

// ── #588 prevalence ordering ────────────────────────────────────────────────
// Tested against FABRICATED snapshots only, with one exception at the bottom
// that checks the committed snapshot for INTERNAL CONSISTENCY rather than for
// content. Asserting on `PREVALENCE_SNAPSHOT`'s counts would bake one mining
// run's live-feed sample into the suite, so every regeneration would break tests
// that are not about the change.
describe("applyPrevalenceOrder", () => {
  const curated: readonly RoleProfile[] = [
    {
      id: "alpha",
      label: "Alpha",
      family: "backend",
      rungs: [1],
      titles: ["first title", "second title", "third title"],
      skills: ["python", "java", "go"],
    },
    {
      id: "beta",
      label: "Beta",
      family: "frontend",
      rungs: [1],
      titles: ["beta lead", "beta engineer"],
      skills: ["react", "css"],
    },
  ];

  /** A skill tally that clears both skill-axis floors, ranked as given. */
  const RANKABLE_SKILLS = [
    { form: "go", count: 70 },
    { form: "java", count: 12 },
  ];
  /** A title tally that clears EVERY title-axis gate, with room on each so a
   *  test using it fails on the behaviour it names and not on a boundary:
   *  the curated head ("first title") holds 40/160 = 25% (floor 20%), the
   *  foreign modal holds 70/160 ≈ 44% (ceiling 50%), and the modal's lead over
   *  the head is 30 against a noise floor of √110 ≈ 10.5. */
  const RANKABLE_TITLES = [
    { form: "third title", count: 70 },
    { form: "first title", count: 40 },
    { form: "second title", count: 50 },
  ];

  function snapshotOf(
    profiles: Record<string, Omit<ProfilePrevalence, "audit">>,
    unobserved: readonly string[] = [],
  ): PrevalenceSnapshot {
    return {
      generatedAt: "2026-07-25",
      corpusSize: 1000,
      providerMix: { remotive: 1000 },
      // The `audit` field is what the harness BAKES; `applyPrevalenceOrder`
      // recomputes it and never reads the baked copy, so the fixtures below can
      // omit it. `auditPrevalence` fills it in for the assertions that need it.
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([id, entry]) => {
          const profile = curated.find((p) => p.id === id);
          return [
            id,
            { ...entry, audit: auditPrevalence(profile ?? curated[0], entry) },
          ];
        }),
      ),
      unobservedProfiles: unobserved,
    };
  }

  it("reorders a healthy profile on both axes by observed count", () => {
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: MIN_PREVALENCE_SAMPLE,
          titles: RANKABLE_TITLES,
          skills: RANKABLE_SKILLS,
        },
      }),
    );
    expect(alpha.titles).toEqual(["third title", "second title", "first title"]);
    // "python" was never observed, so it falls to the tail — behind every
    // observed skill, but keeping its curated position relative to other
    // unobserved terms.
    expect(alpha.skills).toEqual(["go", "java", "python"]);
  });

  it("leaves a profile absent from the snapshot exactly as curated", () => {
    const ordered = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: 500,
          titles: RANKABLE_TITLES,
          skills: RANKABLE_SKILLS,
        },
      }),
    );
    const beta = ordered[1];
    expect(beta.titles).toEqual(curated[1].titles);
    expect(beta.skills).toEqual(curated[1].skills);
    // Untouched by reference — the fallback does not rebuild the object.
    expect(beta).toBe(curated[1]);
  });

  it("returns a profile by reference when NEITHER axis clears its gate", () => {
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: MIN_PREVALENCE_SAMPLE - 1,
          titles: [{ form: "third title", count: 999 }],
          skills: [{ form: "go", count: 9 }],
        },
      }),
    );
    expect(alpha).toBe(curated[0]);
  });

  // ── The two axes are gated independently (#588 review, B1) ────────────────
  // `sampleSize` counts postings, and a posting joins on its TITLE. Its skills
  // come from its description, which a feed may not have supplied at all — so
  // one gate over both axes lets the title axis's evidence authorise the skill
  // ranking. These two tests pin that each axis stands or falls on its own.

  it("ranks skills while declining titles when only the skill axis has evidence", () => {
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: MIN_PREVALENCE_SAMPLE - 1,
          titles: [{ form: "third title", count: 999 }],
          skills: RANKABLE_SKILLS,
        },
      }),
    );
    expect(alpha.titles).toBe(curated[0].titles);
    expect(alpha.skills).toEqual(["go", "java", "python"]);
  });

  it("ranks titles while declining skills when the descriptions were unreadable", () => {
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: 500,
          titles: RANKABLE_TITLES,
          // A whole profile's worth of postings, five skill observations
          // between them: enough to name a head, nowhere near enough to rank.
          skills: [
            { form: "go", count: 4 },
            { form: "java", count: 1 },
          ],
        },
      }),
    );
    expect(alpha.titles).toEqual(["third title", "second title", "first title"]);
    expect(alpha.skills).toBe(curated[0].skills);
  });

  it("declines the skill axis on a flat tally that clears the total but not the head", () => {
    // Five skills at nine observations apiece: 45 clears the total floor, but
    // no single term is a repeated ask, so the "ranking" is five coin flips and
    // its head is what would ship as advice.
    const wide = ["python", "java", "go", "rust", "kotlin"];
    const audit = auditPrevalence(
      { ...curated[0], skills: wide },
      {
        sampleSize: 500,
        titles: RANKABLE_TITLES,
        skills: wide.map((form) => ({ form, count: 9 })),
      },
    );
    expect(audit.skillObservations).toBeGreaterThanOrEqual(
      MIN_PREVALENCE_SKILL_OBSERVATIONS,
    );
    expect(audit.skillHeadCount).toBeLessThan(MIN_PREVALENCE_SKILL_HEAD_COUNT);
    expect(audit.skills).toBe("thin-observations");
  });

  it("declines the skill axis on a strong head with too few observations behind it", () => {
    // The mirror of the test above, and the reason `MIN_PREVALENCE_SKILL_
    // OBSERVATIONS` needs a fixture of its own: with only the head-count floor
    // in play, twelve mentions of one term and five of another would authorise
    // a ranking of the whole list — including the terms nobody mentioned, whose
    // order would then be pure curation wearing a measured label.
    const thin = {
      sampleSize: 500,
      titles: RANKABLE_TITLES,
      skills: [
        { form: "go", count: 12 },
        { form: "java", count: 5 },
      ],
    };
    const audit = auditPrevalence(curated[0], thin);
    expect(audit.skillHeadCount).toBeGreaterThanOrEqual(
      MIN_PREVALENCE_SKILL_HEAD_COUNT,
    );
    expect(audit.skillObservations).toBeLessThan(MIN_PREVALENCE_SKILL_OBSERVATIONS);
    expect(audit.skills).toBe("thin-observations");

    const [alpha] = applyPrevalenceOrder(curated, snapshotOf({ alpha: thin }));
    // Curated skill order ships untouched, even though "go" led decisively.
    expect(alpha.skills).toBe(curated[0].skills);
    // The title axis still ranked, so this is the skill gate firing alone.
    expect(alpha.titles).toEqual(["third title", "second title", "first title"]);
  });

  // ── The bucketing-concentration guard (#588 review, B2) ───────────────────

  it("refuses the title ranking when the bucket is mostly a different role", () => {
    // The `support-engineer` shape: `resolveProfilesByTitles` routes every
    // Customer Success Manager posting to the Support Engineer profile because
    // CSM is one of its curated titles, so 85% of a healthy-looking sample is a
    // different job — and the counts would then make "Customer Success Manager"
    // the answer to "what is this role commonly called". A bigger sample makes
    // this worse, not better, so the guard is on composition, not size.
    const contaminated = {
      sampleSize: 500,
      titles: [
        { form: "third title", count: 90 },
        { form: "first title", count: 4 },
        { form: "second title", count: 2 },
      ],
      skills: RANKABLE_SKILLS,
    };
    const audit = auditPrevalence(curated[0], contaminated);
    expect(audit.modalTitle).toBe("third title");
    expect(audit.curatedHeadTitleShare).toBeLessThan(MIN_CURATED_HEAD_TITLE_SHARE);

    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({ alpha: contaminated }),
    );
    expect(alpha.titles).toBe(curated[0].titles);
    expect(alpha.titles[0]).toBe("first title");
    // Only the TITLE axis is refused — the descriptions were still readable.
    expect(alpha.skills).toEqual(["go", "java", "python"]);
  });

  it("allows a genuine rename: modal is not the head, but the head still holds", () => {
    // The `machine-learning-engineer` shape — "AI Engineer" really did overtake
    // "Machine Learning Engineer" while the latter stayed a strong runner-up.
    // That is the market renaming a role, and refusing it would throw away the
    // measurement this whole mechanism exists to make.
    const renamed = {
      sampleSize: 500,
      titles: [
        { form: "third title", count: 35 },
        { form: "first title", count: 25 },
        { form: "second title", count: 40 },
      ],
      skills: RANKABLE_SKILLS,
    };
    const audit = auditPrevalence(curated[0], renamed);
    expect(audit.modalTitle).toBe("second title");
    expect(audit.curatedHeadTitleShare).toBeGreaterThanOrEqual(
      MIN_CURATED_HEAD_TITLE_SHARE,
    );

    const [alpha] = applyPrevalenceOrder(curated, snapshotOf({ alpha: renamed }));
    expect(alpha.titles).toEqual(["second title", "third title", "first title"]);
  });

  // ── The modal ceiling (#588 round 2, S-B) ────────────────────────────────

  it("refuses a bucket whose foreign modal is an outright majority, however well the head polls", () => {
    // The half of the stated standard `MIN_CURATED_HEAD_TITLE_SHARE` cannot
    // reach. Its docblock promises a two-sided test — "a rename leaves the
    // curated head a strong runner-up" — but it only floors the loser, so a
    // head at 21% passes while a foreign form owns 70% of the bucket and would
    // become this role's name.
    const dominated = {
      sampleSize: 500,
      titles: [
        { form: "third title", count: 70 },
        { form: "first title", count: 21 },
        { form: "second title", count: 9 },
      ],
      skills: RANKABLE_SKILLS,
    };
    const audit = auditPrevalence(curated[0], dominated);
    // Both the reasons it is NOT refused for, so the ceiling is what fired:
    expect(audit.curatedHeadTitleShare).toBeGreaterThanOrEqual(
      MIN_CURATED_HEAD_TITLE_SHARE,
    );
    expect(audit.modalTitleShare).toBeGreaterThan(MAX_FOREIGN_MODAL_TITLE_SHARE);
    expect(audit.titles).toBe("bucket-not-this-role");

    const [alpha] = applyPrevalenceOrder(curated, snapshotOf({ alpha: dominated }));
    expect(alpha.titles).toBe(curated[0].titles);
  });

  it("is not made redundant by the margin gate: a dominant modal's lead is huge", () => {
    // The reason the ceiling is a separate constant rather than a corollary.
    // 70 vs 21 is a 49-observation lead against a noise floor of √91 ≈ 9.5, so
    // the margin gate would wave it straight through — it asks whether the flip
    // is REAL, which it is. The ceiling asks a different question: whether the
    // bucket is this role's to flip.
    const lead = 70 - 21;
    expect(lead).toBeGreaterThan(Math.sqrt(70 + 21));
  });

  // ── The head-flip margin gate (#588 round 2) ──────────────────────────────

  it("pins the curated head when the modal's lead is inside the noise", () => {
    // The `machine-learning-engineer` shape: "ai engineer" 14 against "machine
    // learning engineer" 11 out of 40 observations. Both existing gates pass —
    // a healthy sample, and the head is a strong runner-up — and yet a 3-count
    // lead over 25 observations is what a fair coin produces routinely
    // (√25 = 5). Calling that an ORDER, and then quoting its head as a common
    // title for the role, over-asserts what was measured.
    const nearTie = {
      sampleSize: 500,
      titles: [
        { form: "third title", count: 14 },
        { form: "first title", count: 11 },
        { form: "second title", count: 13 },
      ],
      skills: RANKABLE_SKILLS,
    };
    const audit = auditPrevalence(curated[0], nearTie);
    expect(audit.modalTitle).toBe("third title");
    expect(audit.titles).toBe("ranked-head-pinned");

    const [alpha] = applyPrevalenceOrder(curated, snapshotOf({ alpha: nearTie }));
    // Position 0 is held at the curated head — NOT the modal, which is what an
    // unguarded ranking would have put there.
    expect(alpha.titles[0]).toBe("first title");
    // The tail is still measured: "third title" (14) now precedes "second
    // title" (13), which is neither the curated order nor the ranked order.
    expect(alpha.titles).toEqual(["first title", "third title", "second title"]);
    expect(alpha.titles).not.toEqual(curated[0].titles);
    // Membership is untouched by the pin.
    expect([...alpha.titles].sort()).toEqual([...curated[0].titles].sort());
    // The skill axis is unaffected — this gate is about position 0 of `titles`.
    expect(alpha.skills).toEqual(["go", "java", "python"]);
  });

  it("lets the head flip when the lead is bigger than the noise", () => {
    // The other side of the same gate, and the reason it is one sigma rather
    // than a blanket "never flip the head": 30 against 20 is a 10-observation
    // lead over 50, and √50 ≈ 7.07. A market that really did rename a role
    // clears this, and the measurement is allowed to stand.
    const renamedHard = {
      sampleSize: 500,
      titles: [
        { form: "third title", count: 30 },
        { form: "first title", count: 20 },
        { form: "second title", count: 25 },
      ],
      skills: RANKABLE_SKILLS,
    };
    const audit = auditPrevalence(curated[0], renamedHard);
    expect(audit.titles).toBe("ranked");
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({ alpha: renamedHard }),
    );
    expect(alpha.titles).toEqual(["third title", "second title", "first title"]);
  });

  it("never lets a one-posting lead flip the head, at any sample size", () => {
    // The property the sqrt derivation buys, stated as a property rather than
    // as a case: a margin of 1 is below √n for every n ≥ 2, so this holds for a
    // bucket of 30 observations and for one of 30,000 alike.
    for (const modalCount of [3, 40, 400, 4000]) {
      const audit = auditPrevalence(curated[0], {
        sampleSize: 500,
        titles: [
          { form: "third title", count: modalCount },
          { form: "first title", count: modalCount - 1 },
          // A third term carrying its share, purely so the modal is not
          // trivially a majority of a two-horse bucket and this test exercises
          // the noise floor rather than `MAX_FOREIGN_MODAL_TITLE_SHARE`.
          { form: "second title", count: modalCount - 1 },
        ],
        skills: [],
      });
      expect(audit.modalTitle).toBe("third title");
      expect(audit.titles).toBe("ranked-head-pinned");
    }
  });

  it("never asks for permission when the curated head already leads the bucket", () => {
    const audit = auditPrevalence(curated[0], {
      sampleSize: 500,
      titles: [{ form: "first title", count: 3 }],
      skills: [],
    });
    // A one-in-one share is trivially above the floor, but the point is the
    // branch: a profile whose own head is modal is never subject to the guard.
    expect(audit.modalTitle).toBe("first title");
    expect(audit.titles).toBe("ranked");
  });

  it("never ADDS a term the curated list does not carry", () => {
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: 500,
          // Both of these outrank every curated term by count. Neither may appear.
          titles: [
            { form: "rockstar ninja guru", count: 100_000 },
            { form: "first title", count: 50 },
            { form: "second title", count: 90 },
            { form: "third title", count: 70 },
          ],
          skills: [
            { form: "cobol", count: 100_000 },
            { form: "java", count: 30 },
            { form: "go", count: 20 },
          ],
        },
      }),
    );
    expect(alpha.titles).not.toContain("rockstar ninja guru");
    expect(alpha.skills).not.toContain("cobol");
    expect([...alpha.titles].sort()).toEqual([...curated[0].titles].sort());
    expect([...alpha.skills].sort()).toEqual([...curated[0].skills].sort());
    // The curated terms the snapshot DID name still moved, so the drop is a
    // membership filter, not the whole snapshot being ignored.
    expect(alpha.titles[0]).toBe("second title");
    expect(alpha.skills[0]).toBe("java");
  });

  it("does not count an uncurated term towards either gate", () => {
    // The membership filter and the gates must agree on what counts as
    // evidence: a snapshot stuffed with terms this profile does not carry must
    // not be able to buy itself a ranking it has no curated evidence for.
    const audit = auditPrevalence(curated[0], {
      sampleSize: 500,
      titles: [{ form: "rockstar ninja guru", count: 100_000 }],
      skills: [{ form: "cobol", count: 100_000 }],
    });
    expect(audit.skillObservations).toBe(0);
    expect(audit.skills).toBe("thin-observations");
    expect(audit.modalTitle).toBe("");
    expect(audit.titles).toBe("bucket-not-this-role");
  });

  it("joins titles on the token SET, not the literal string", () => {
    const [, beta] = applyPrevalenceOrder(
      [
        curated[0],
        { ...curated[1], titles: ["director of engineering", "beta engineer"] },
      ],
      snapshotOf({
        beta: {
          sampleSize: 500,
          // Same token set, written the other way round.
          titles: [{ form: "Engineering Director", count: 400 }],
          skills: [],
        },
      }),
    );
    expect(beta.titles[0]).toBe("director of engineering");
  });

  it("keeps curated order for terms observed the same number of times", () => {
    // Ties keep the curated order — the only ordering information left once the
    // counts say nothing.
    //
    // Honest about what this does and does not prove: deleting the
    // `|| a.index - b.index` clause from the comparator does NOT fail this test,
    // because `Array.prototype.sort` has been stable since ES2019 and produces
    // the same answer without it. The clause is belt-and-braces and the coverage
    // here is of the PROPERTY, not of the clause — no test can distinguish them.
    // What this does catch is a comparator that stops falling back to curated
    // order at all: an added third key, a `Math.random()` shuffle, a switch to
    // an unstable hand-rolled sort.
    const [alpha] = applyPrevalenceOrder(
      curated,
      snapshotOf({
        alpha: {
          sampleSize: 500,
          titles: [
            { form: "third title", count: 60 },
            { form: "second title", count: 60 },
            { form: "first title", count: 60 },
          ],
          skills: [
            { form: "go", count: 20 },
            { form: "java", count: 20 },
            { form: "python", count: 20 },
          ],
        },
      }),
    );
    expect(alpha.titles).toEqual(curated[0].titles);
    expect(alpha.skills).toEqual(curated[0].skills);
  });

  it("is total over a degenerate snapshot", () => {
    const empty = snapshotOf({});
    expect(applyPrevalenceOrder(curated, empty)).toEqual(curated);
    expect(applyPrevalenceOrder([], empty)).toEqual([]);
    expect(() =>
      applyPrevalenceOrder(
        curated,
        snapshotOf({
          alpha: {
            sampleSize: 500,
            titles: [{ form: "", count: 5 }],
            skills: [{ form: "", count: 5 }],
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      auditPrevalence(
        { ...curated[0], titles: [], skills: [] },
        { sampleSize: 500, titles: [], skills: [] },
      ),
    ).not.toThrow();
  });
});

describe("the committed prevalence snapshot", () => {
  // Content-free by design: these assert the committed file is internally
  // consistent, which survives every regeneration. A hand-edited count — the
  // one thing the GENERATED banner cannot prevent — desynchronises the baked
  // `audit` from what `applyPrevalenceOrder` will actually do, and that is what
  // fails here.
  const byId = new Map(CURATED_ROLE_PROFILES.map((p) => [p.id, p] as const));

  it("bakes an audit that matches what the consumer recomputes", () => {
    for (const [id, entry] of Object.entries(PREVALENCE_SNAPSHOT.profiles)) {
      const profile = byId.get(id);
      expect(profile, `snapshot names unknown profile "${id}"`).toBeDefined();
      expect(entry.audit, `no baked audit for "${id}"`).toEqual(
        auditPrevalence(profile as RoleProfile, entry),
      );
    }
  });

  it("separates profiles that were never observed from those that were declined", () => {
    for (const id of PREVALENCE_SNAPSHOT.unobservedProfiles) {
      expect(byId.has(id)).toBe(true);
      expect(PREVALENCE_SNAPSHOT.profiles[id]).toBeUndefined();
    }
  });

  it("only ever reordered the profiles its own audit says it ranked", () => {
    for (const profile of CURATED_ROLE_PROFILES) {
      const audit = PREVALENCE_SNAPSHOT.profiles[profile.id]?.audit;
      const shipped = ROLE_PROFILES.find((p) => p.id === profile.id) as RoleProfile;
      if (audit?.titles === "ranked-head-pinned") {
        // The tail moved, position 0 did not.
        expect(shipped.titles[0]).toBe(profile.titles[0]);
      } else if (audit?.titles !== "ranked") {
        expect(shipped.titles).toEqual(profile.titles);
      }
      if (audit?.skills !== "ranked") expect(shipped.skills).toEqual(profile.skills);
      // Whatever happened, membership is untouched — the permutation invariant
      // over the real table, not a fabricated one.
      expect([...shipped.titles].sort()).toEqual([...profile.titles].sort());
      expect([...shipped.skills].sort()).toEqual([...profile.skills].sort());
    }
  });
});

describe("roleProfileById", () => {
  it("returns the profile or undefined, never throws", () => {
    expect(roleProfileById("cto")?.label).toBe("CTO");
    expect(roleProfileById("no-such-role")).toBeUndefined();
    expect(() => roleProfileById(undefined as unknown as string)).not.toThrow();
  });
});

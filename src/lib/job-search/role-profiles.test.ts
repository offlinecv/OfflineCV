// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  ROLE_PROFILES,
  ROLE_PROFILES_VERSION,
  resolveProfilesByTitles,
  resolveProfilesBySkills,
  roleProfileById,
} from "./role-profiles.ts";
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
    expect(ROLE_PROFILES_VERSION).toBe("1.0");
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

describe("roleProfileById", () => {
  it("returns the profile or undefined, never throws", () => {
    expect(roleProfileById("cto")?.label).toBe("CTO");
    expect(roleProfileById("no-such-role")).toBeUndefined();
    expect(() => roleProfileById(undefined as unknown as string)).not.toThrow();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { SKILLS, getSkillIndex, skillCount } from "./skills.ts";

describe("skills dictionary", () => {
  it("ships at least 100 canonical skills (issue acceptance criterion)", () => {
    expect(skillCount()).toBeGreaterThanOrEqual(100);
  });

  it("has at least one alias per entry, including the canonical ID", () => {
    for (const entry of SKILLS) {
      expect(entry.aliases.length).toBeGreaterThan(0);
    }
  });

  it("never maps the same alias to two different canonical IDs", () => {
    const aliasToId = new Map<string, string>();
    for (const entry of SKILLS) {
      for (const alias of entry.aliases) {
        const lower = alias.toLowerCase();
        const existing = aliasToId.get(lower);
        if (existing !== undefined && existing !== entry.id) {
          throw new Error(
            `Alias "${alias}" collides between "${existing}" and "${entry.id}"`,
          );
        }
        aliasToId.set(lower, entry.id);
      }
    }
  });

  it("compiles a single regex that matches multi-word aliases longest-first", () => {
    const index = getSkillIndex();
    // 'ruby on rails' should win over 'ruby' inside a single regex sweep.
    const matches = Array.from("we love ruby on rails here".matchAll(index.pattern));
    expect(matches.length).toBeGreaterThan(0);
    const captured = matches.map((m) => m[1].toLowerCase());
    expect(captured).toContain("ruby on rails");
    expect(captured).not.toContain("ruby");
  });

  it("matches aliases case-insensitively at word boundaries", () => {
    const index = getSkillIndex();
    const re = new RegExp(index.pattern.source, index.pattern.flags);
    const matches = Array.from("Built with TypeScript, React, and K8s.".matchAll(re));
    const ids = matches.map((m) => index.aliasToId.get(m[1].toLowerCase()));
    expect(ids).toEqual(expect.arrayContaining(["typescript", "react", "kubernetes"]));
  });
});

// #583 — leadership/management competency block. Listed by ID here (rather
// than re-deriving membership from the file) so the test fails loudly if an
// ID gets renamed without updating this list.
const LEADERSHIP_SKILL_IDS = [
  "people-management",
  "technical-recruiting",
  "performance-management",
  "coaching-mentorship",
  "career-development",
  "org-design",
  "team-building",
  "roadmap-ownership",
  "project-delivery",
  "program-management",
  "agile-leadership",
  "incident-management",
  "on-call-ownership",
  "technical-strategy",
  "architecture-review",
  "platform-ownership",
  "vendor-management",
  "budget-headcount-planning",
  "pnl-ownership",
  "stakeholder-management",
  "cross-functional-collaboration",
  "executive-communication",
  "technical-writing",
];

describe("leadership/management competencies (#583)", () => {
  it("adds every expected canonical ID", () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    for (const id of LEADERSHIP_SKILL_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("never uses a bare single common English word as an alias", () => {
    // Generic business/English words that are ambiguous on their own and
    // would false-positive against ordinary bullet prose — the file's
    // docblock explicitly warns against exactly this ("go", "r" are the
    // tool-taxonomy analog). Every leadership alias must be a specific
    // multi-word phrase instead.
    const genericWords = new Set([
      "management", "leadership", "strategy", "planning", "communication",
      "writing", "hiring", "recruiting", "coaching", "mentoring", "mentorship",
      "review", "reviews", "delivery", "ownership", "design", "growth",
      "development", "budget", "vendor", "incident", "architecture",
      "stakeholder", "team", "program", "project", "platform", "org",
    ]);
    const leadershipEntries = SKILLS.filter((s) => LEADERSHIP_SKILL_IDS.includes(s.id));
    expect(leadershipEntries.length).toBe(LEADERSHIP_SKILL_IDS.length);
    for (const entry of leadershipEntries) {
      for (const alias of entry.aliases) {
        const isBareSingleWord = !/[\s/&]/.test(alias);
        if (isBareSingleWord) {
          expect(genericWords.has(alias)).toBe(false);
        }
      }
    }
  });

  it("matches realistic bullet phrasing for a sample of the new competencies", () => {
    const index = getSkillIndex();
    const bullets = [
      "Managed a team of 12 engineers across three squads.",
      "Led hiring for the platform org, growing headcount 3x.",
      "Owned the roadmap for the payments platform.",
      "Acted as incident commander for Sev-1 outages.",
      "Drove cross-functional collaboration between design and eng.",
    ];
    const hits = new Set<string>();
    for (const bullet of bullets) {
      const re = new RegExp(index.pattern.source, index.pattern.flags);
      for (const m of bullet.matchAll(re)) {
        const id = index.aliasToId.get(m[1].toLowerCase());
        if (id) hits.add(id);
      }
    }
    expect(hits).toEqual(
      new Set([
        "people-management",
        "technical-recruiting",
        "roadmap-ownership",
        "incident-management",
        "cross-functional-collaboration",
      ]),
    );
  });
});

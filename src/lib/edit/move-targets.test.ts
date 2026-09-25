// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * buildSectionMoveTargets — the "move to role" affordance's per-section
 * bucket-key resolution (#1007). Pins the same three rules
 * `ExperienceSection`/`ProjectsSection`/`AchievementsSection` already apply
 * per-row: a survivor resolves through `parsedIndices` (#856), an appended
 * user-added entry resolves to its own id, and the "Other" group itself
 * (`experienceIndex: null`) is never a candidate target.
 */

import { describe, expect, it } from "vitest";
import { buildMoveTargets, buildSectionMoveTargets } from "./move-targets.ts";
import { buildEntryGroups, type BulletGroup } from "../score/group-bullets.ts";
import type { AddedEntry } from "../../hooks/useEditableParse.ts";
import { applyOverrides } from "./apply-overrides.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";

function group(experienceIndex: number | null, title?: string, company?: string): BulletGroup {
  return {
    experienceIndex,
    experience:
      experienceIndex === null ? null : { title, company, description: "" },
    bullets: [],
  };
}

describe("buildSectionMoveTargets", () => {
  it("resolves a parsed survivor through parsedEntryKey, unaffected by deletions elsewhere", () => {
    // Render position 0, but the SURVIVING parsed index is 2 — an earlier
    // sibling was deleted (#856), which is exactly what `parsedIndices`
    // exists to translate.
    const groups = [group(0, "Staff Engineer", "Northwind")];
    const targets = buildSectionMoveTargets(
      "experience",
      groups,
      /* parsedIndices */ [2],
      /* addedEntries */ [],
      /* originalCount */ 1,
    );
    expect(targets).toEqual([
      { key: "experience:2", section: "experience", label: "Staff Engineer — Northwind" },
    ]);
  });

  it("resolves an appended user-added entry to its own id, not a parsedEntryKey", () => {
    const added: AddedEntry = { id: "added:7", section: "projects", title: "Side project" };
    // One survivor at render position 0, the added entry appended at 1 —
    // "indices at/above originalCount are user-added" (ExperienceSection's
    // own doc comment on `addedExperience`/`addedProjects`).
    const groups = [group(0, "Real project"), group(1, "Side project")];
    const targets = buildSectionMoveTargets(
      "projects",
      groups,
      /* parsedIndices */ [0],
      /* addedEntries */ [added],
      /* originalCount */ 1,
    );
    expect(targets).toEqual([
      { key: "projects:0", section: "projects", label: "Real project" },
      { key: "added:7", section: "projects", label: "Side project" },
    ]);
  });

  it("skips the 'Other' group itself (experienceIndex null) even when present in the list", () => {
    const groups = [group(0, "Only role"), group(null)];
    const targets = buildSectionMoveTargets(
      "experience",
      groups,
      [0],
      [],
      1,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.key).toBe("experience:0");
  });

  it("falls back to roleLabel's own 'Untitled role' when an entry carries neither title nor company", () => {
    const targets = buildSectionMoveTargets(
      "achievements",
      [group(0)],
      [0],
      [],
      1,
    );
    expect(targets[0]!.label).toBe("Untitled role");
  });

  it("returns [] for an empty section (no parsed entries, nothing added)", () => {
    expect(buildSectionMoveTargets("certifications", [], [], [], 0)).toEqual([]);
  });
});

describe("buildMoveTargets", () => {
  it("concatenates each section's targets in the order the sections are given", () => {
    const added: AddedEntry = { id: "added:3", section: "achievements", title: "Patent" };
    const targets = buildMoveTargets([
      ["experience", [group(0, "Staff Engineer", "Northwind")], [0], [], 1],
      ["projects", [], [], [], 0],
      ["achievements", [group(0, "Patent")], [], [added], 0],
    ]);
    expect(targets).toEqual([
      { key: "experience:0", section: "experience", label: "Staff Engineer — Northwind" },
      { key: "added:3", section: "achievements", label: "Patent" },
    ]);
  });

  it("returns [] when no section has an entry", () => {
    expect(buildMoveTargets([])).toEqual([]);
    expect(buildMoveTargets([["experience", [], [], [], 0]])).toEqual([]);
  });
});

describe("move targets from real buildEntryGroups output", () => {
  // `buildEntryGroups` numbers project / achievement / certification groups in
  // ONE combined index space (offset by every earlier section), unlike the
  // section-local stubs above. A move target keyed off that index named
  // `projects:2` for the only project, which `applyOverrides` resolves to no
  // entry — the moved bullet was dropped.
  const parsed: HeuristicParsedResume = {
    full_name: "Riley Park",
    email: "riley@example.com",
    skills: [],
    experience: [
      { title: "Engineer", company: "Northwind", description: "Built the billing service" },
      { title: "Analyst", company: "Contoso", description: "Modelled churn" },
    ],
    education: [],
    projects: [{ name: "Trail Mapper", description: "Mapped 40 trails" }],
    heuristic_achievements: [{ title: "Hackathon winner", description: "Won the city hackathon" }],
  };
  const sections: SectionedResume = {
    byName: new Map() as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };

  it("keys each accomplishment section by its own entries, and a move lands there", () => {
    const g = buildEntryGroups(
      parsed.experience,
      parsed.projects ?? [],
      parsed.heuristic_achievements ?? [],
      [],
      [],
    );
    const targets = buildMoveTargets([
      ["experience", g.experienceGroups, [0, 1], [], 2],
      ["projects", g.projectGroups, [0], [], 1],
      ["achievements", g.achievementGroups, [0], [], 1],
    ]);
    expect(targets.map((t) => t.key)).toEqual([
      "experience:0",
      "experience:1",
      "projects:0",
      "achievements:0",
    ]);

    const project = targets.find((t) => t.section === "projects")!;
    const { fields } = applyOverrides(
      { parsed, rawText: "", sections, observations: [] },
      { addedBullets: { [project.key]: ["Cut tile load time by half"] } },
    );
    expect(fields.projects?.[0]?.description).toContain("Cut tile load time by half");
  });
});

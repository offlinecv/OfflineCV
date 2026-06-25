// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { applyOverrides } from "./apply-overrides.ts";
import { groupBulletsByExperience } from "../score/group-bullets.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { BulletObservation } from "../score/score.ts";
import type { SectionedResume } from "../heuristics/sections.ts";

/** Minimal BulletObservation factory — only `text` and `index` matter here. */
function obs(index: number, text: string): BulletObservation {
  return {
    text,
    index,
    hasMetric: false,
    startsWithActionVerb: false,
    wellFormedLength: false,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/** Minimal SectionedResume — bullet edits target the experience section, so
 *  put any bullet lines (with their leading markers) there. */
function makeSections(experience: readonly string[] = []): SectionedResume {
  const byName = new Map<string, readonly string[]>();
  if (experience.length > 0) byName.set("experience", experience);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Doe",
    email: "jane@example.com",
    skills: ["typescript"],
    experience: [
      {
        title: "Engineer",
        company: "Acme",
        start_date: "2020",
        end_date: "2022",
        description: "Built a thing\nShipped another thing",
      },
    ],
    education: [],
  };
}

describe("applyOverrides", () => {
  it("replaces contact fields on a clone", () => {
    const parsed = baseParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      { full_name: "John Smith", email: "john@example.com" },
      {},
      {},
      [],
    );
    expect(out.full_name).toBe("John Smith");
    expect(out.email).toBe("john@example.com");
    // Original untouched.
    expect(parsed.full_name).toBe("Jane Doe");
    expect(parsed.email).toBe("jane@example.com");
  });

  it("treats an empty contact override as cleared (absent)", () => {
    const { parsed: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      { full_name: "" },
      {},
      {},
      [],
    );
    expect(out.full_name).toBeUndefined();
  });

  it("clears a stale phoneIsValid flag when the phone is overridden (#70 review)", () => {
    const parsed: HeuristicParsedResume = {
      ...baseParsed(),
      phone: "555-invalid",
      phoneIsValid: false,
    };
    // User fixes the number → the old `false` must not survive, else the
    // scorer keeps awarding half credit on the corrected phone.
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      { phone: "(312) 555-0123" },
      {},
      {},
      [],
    );
    expect(out.phone).toBe("(312) 555-0123");
    expect(out.phoneIsValid).toBeUndefined();
    // Original untouched.
    expect(parsed.phoneIsValid).toBe(false);
  });

  it("clears a stale phoneIsValid flag when the phone is cleared (#70 review)", () => {
    const parsed: HeuristicParsedResume = {
      ...baseParsed(),
      phone: "555-invalid",
      phoneIsValid: false,
    };
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      { phone: "" },
      {},
      {},
      [],
    );
    expect(out.phone).toBeUndefined();
    expect(out.phoneIsValid).toBeUndefined();
  });

  it("replaces experience header fields by index", () => {
    const parsed = baseParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      { 0: { title: "Senior Engineer", company: "Globex" } },
      {},
      [],
    );
    expect(out.experience[0].title).toBe("Senior Engineer");
    expect(out.experience[0].company).toBe("Globex");
    expect(out.experience[0].start_date).toBe("2020"); // untouched
    // Original untouched.
    expect(parsed.experience[0].title).toBe("Engineer");
  });

  it("propagates a bullet edit to rawText, sections, and the matching description", () => {
    const parsed = baseParsed();
    const rawText = "• Built a thing\n• Shipped another thing";
    const sections = makeSections(["• Built a thing", "• Shipped another thing"]);
    const {
      parsed: out,
      rawText: outRaw,
      sections: outSections,
    } = applyOverrides(
      parsed,
      rawText,
      sections,
      {},
      {},
      { 0: "Built a thing that increased revenue by 30%" },
      [obs(0, "Built a thing"), obs(1, "Shipped another thing")],
    );
    // rawText: marker preserved, body swapped → still extracts as a bullet.
    expect(outRaw).toContain("• Built a thing that increased revenue by 30%");
    expect(outRaw).not.toContain("• Built a thing\n");
    // sections (#133): the anonymous scorer pools from here, so the edited line
    // must land in the experience section — marker preserved.
    expect(outSections.byName.get("experience")).toEqual([
      "• Built a thing that increased revenue by 30%",
      "• Shipped another thing",
    ]);
    // Original section view untouched (immutability).
    expect(sections.byName.get("experience")).toEqual([
      "• Built a thing",
      "• Shipped another thing",
    ]);
    // description: line swapped so JD coverage corpus re-grades.
    expect(out.experience[0].description).toBe(
      "Built a thing that increased revenue by 30%\nShipped another thing",
    );
    // Original parse + rawText untouched.
    expect(parsed.experience[0].description).toBe(
      "Built a thing\nShipped another thing",
    );
    expect(rawText).toBe("• Built a thing\n• Shipped another thing");
  });

  it("matches bullets regardless of leading marker differences", () => {
    // rawText uses a dash marker, description has no marker (stripBullet output).
    const rawText = "- Led the migration effort";
    const { parsed: out, rawText: outRaw } = applyOverrides(
      {
        ...baseParsed(),
        experience: [
          {
            title: "Engineer",
            company: "Acme",
            description: "Led the migration effort",
          },
        ],
      },
      rawText,
      makeSections(["- Led the migration effort"]),
      {},
      {},
      { 5: "Led the migration of 12 services to k8s" },
      [obs(5, "Led the migration effort")],
    );
    expect(outRaw).toBe("- Led the migration of 12 services to k8s");
    expect(out.experience[0].description).toBe(
      "Led the migration of 12 services to k8s",
    );
  });

  it("is a no-op when overrides are empty", () => {
    const parsed = baseParsed();
    const rawText = "• Built a thing";
    const { parsed: out, rawText: outRaw } = applyOverrides(
      parsed,
      rawText,
      makeSections(),
      {},
      {},
      {},
      [],
    );
    expect(out).toEqual(parsed);
    expect(outRaw).toBe(rawText);
  });

  it("is a no-op for a bullet edit equal to the original text", () => {
    const rawText = "• Built a thing";
    const { rawText: outRaw } = applyOverrides(
      baseParsed(),
      rawText,
      makeSections(["• Built a thing"]),
      {},
      {},
      { 0: "Built a thing" },
      [obs(0, "Built a thing")],
    );
    expect(outRaw).toBe(rawText);
  });

  it("is a no-op for an empty bullet edit (does not drop the bullet)", () => {
    const rawText = "• Built a thing";
    const parsed = baseParsed();
    const { rawText: outRaw, parsed: out } = applyOverrides(
      parsed,
      rawText,
      makeSections(["• Built a thing"]),
      {},
      {},
      { 0: "   " },
      [obs(0, "Built a thing")],
    );
    expect(outRaw).toBe(rawText);
    expect(out.experience[0].description).toBe(
      "Built a thing\nShipped another thing",
    );
  });

  it("does not mutate the input parsed object (clone check)", () => {
    const parsed = baseParsed();
    const snapshot = JSON.parse(JSON.stringify(parsed));
    applyOverrides(
      parsed,
      "• Built a thing",
      makeSections(["• Built a thing"]),
      { full_name: "X" },
      { 0: { title: "Y" } },
      { 0: "Built a different thing" },
      [obs(0, "Built a thing")],
    );
    expect(parsed).toEqual(snapshot);
  });
});

// ── Education + skills overrides (#176) ───────────────────────────────────────

function eduParsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Doe",
    email: "jane@example.com",
    skills: ["TypeScript", "Python"],
    experience: [],
    education: [
      { degree: "B.S. Computer Science", institution: "State University" },
      { degree: "M.S. Data Science", institution: "Tech Institute" },
    ],
  };
}

describe("applyOverrides — education", () => {
  it("replaces an education field by index on a clone", () => {
    const parsed = eduParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 0: { degree: "B.S. Software Engineering", institution: "MIT" } },
    );
    expect(out.education[0].degree).toBe("B.S. Software Engineering");
    expect(out.education[0].institution).toBe("MIT");
    // Untouched entry.
    expect(out.education[1].degree).toBe("M.S. Data Science");
    // Original untouched.
    expect(parsed.education[0].degree).toBe("B.S. Computer Science");
  });

  it("writes education dates so buildEducationDates reflects them", () => {
    const { parsed: out } = applyOverrides(
      eduParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 0: { start_date: "2018", end_date: "2022" } },
    );
    expect(out.education[0].start_date).toBe("2018");
    expect(out.education[0].end_date).toBe("2022");
  });

  it("treats an empty education field override as cleared ('not detected')", () => {
    const { parsed: out } = applyOverrides(
      eduParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 1: { institution: "" } },
    );
    expect(out.education[1].institution).toBe("");
  });

  it("ignores an education override for an out-of-range index", () => {
    const parsed = eduParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 5: { degree: "PhD" } },
    );
    expect(out.education).toHaveLength(2);
    expect(out.education[0].degree).toBe("B.S. Computer Science");
  });
});

describe("applyOverrides — skills", () => {
  it("removes a parsed skill by lower-cased key", () => {
    const parsed = eduParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: ["python"], added: [] },
    );
    expect(out.skills).toEqual(["TypeScript"]);
    // Original untouched.
    expect(parsed.skills).toEqual(["TypeScript", "Python"]);
  });

  it("appends an added skill, de-duplicated case-insensitively", () => {
    const { parsed: out } = applyOverrides(
      eduParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: ["Go", "typescript"] }, // "typescript" already present
    );
    expect(out.skills).toEqual(["TypeScript", "Python", "Go"]);
  });

  it("applies removal then addition together", () => {
    const { parsed: out } = applyOverrides(
      eduParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: ["typescript"], added: ["Rust"] },
    );
    expect(out.skills).toEqual(["Python", "Rust"]);
  });

  it("is a no-op when the skills override is empty", () => {
    const parsed = eduParsed();
    const { parsed: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
    );
    expect(out.skills).toEqual(["TypeScript", "Python"]);
  });

  it("does not mutate the input parsed object across education + skills edits", () => {
    const parsed = eduParsed();
    const snapshot = JSON.parse(JSON.stringify(parsed));
    applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 0: { degree: "Changed" } },
      { removed: ["python"], added: ["Rust"] },
    );
    expect(parsed).toEqual(snapshot);
  });
});

// ── Regression: edit + re-group attribution ──────────────────────────────────

/**
 * The original bug: editing a bullet caused it to fall into the trailing
 * "Other bullets" group instead of staying under its role. Root cause was at
 * the App.tsx wiring layer — the post-edit bullets (with edited text) were
 * being looked up against pre-edit experience descriptions. This regression
 * test pins down the contract that protects against re-introducing the bug:
 *
 *   applyOverrides → use the RETURNED `parsed.experience` (not the original)
 *   when re-running groupBulletsByExperience with the edited bullet text.
 *
 * If a future refactor passes the un-edited descriptions to grouping again,
 * these tests fail and point at the bug.
 */
describe("regression: post-edit bullet re-grouping (issue #63 testing artefact)", () => {
  it("edited bullet stays under its original experience when grouping uses the returned parsed.experience", () => {
    const parsed: HeuristicParsedResume = {
      full_name: "Jane Smith",
      email: "jane@example.com",
      skills: [],
      experience: [
        {
          title: "Senior Engineer",
          company: "Globex",
          description:
            "Built event-driven data pipeline.\nReduced deploy time by 50%.",
        },
        {
          title: "Engineer",
          company: "Initech",
          description: "Migrated legacy monolith.",
        },
      ],
      education: [],
    };
    const rawText =
      "Globex\n• Built event-driven data pipeline.\n• Reduced deploy time by 50%.\nInitech\n• Migrated legacy monolith.";
    const observations = [
      obs(0, "Built event-driven data pipeline."),
      obs(1, "Reduced deploy time by 50%."),
      obs(2, "Migrated legacy monolith."),
    ];

    // User edits bullet #1 to add a new metric.
    const editedText = "Reduced deploy time by 50%, saving $50K in compute.";
    const result = applyOverrides(
      parsed,
      rawText,
      makeSections([
        "• Built event-driven data pipeline.",
        "• Reduced deploy time by 50%.",
        "• Migrated legacy monolith.",
      ]),
      {},
      {},
      { 1: editedText },
      observations,
    );

    // Sanity: BOTH rawText and the role's description picked up the edit.
    expect(result.rawText).toContain("$50K");
    expect(result.parsed.experience[0].description).toContain("$50K");

    // Now simulate the post-edit re-grouping. The bullets carry the edited
    // text (as they would after re-grading); the descriptions ALSO carry the
    // edited text (because we use the RETURNED parsed.experience, not the
    // original). The edited bullet must stay under Globex (experienceIndex 0)
    // — NOT fall into the trailing Other group.
    const postEditBullets = [
      obs(0, "Built event-driven data pipeline."),
      obs(1, editedText),
      obs(2, "Migrated legacy monolith."),
    ];
    const groups = groupBulletsByExperience(
      postEditBullets,
      result.parsed.experience,
    );

    const globexGroup = groups.find((g) => g.experienceIndex === 0);
    expect(globexGroup).toBeDefined();
    expect(globexGroup!.bullets.map((b) => b.text)).toEqual([
      "Built event-driven data pipeline.",
      editedText,
    ]);
    // No Other group — every bullet attributed to its role.
    expect(groups.find((g) => g.experienceIndex === null)).toBeUndefined();
  });

  it("DEMONSTRATES the bug: grouping against the ORIGINAL parsed.experience misattributes the edited bullet", () => {
    // This test pins the failure mode in case anyone "simplifies" App.tsx
    // back to passing the original parsed.experience to ReconstructedResume.
    const parsed: HeuristicParsedResume = {
      full_name: "Jane Smith",
      email: "jane@example.com",
      skills: [],
      experience: [
        {
          title: "Senior Engineer",
          company: "Globex",
          description: "Reduced deploy time by 50%.",
        },
      ],
      education: [],
    };
    const observations = [obs(0, "Reduced deploy time by 50%.")];
    const editedText = "Reduced deploy time by 50%, saving $50K in compute.";

    applyOverrides(
      parsed,
      "• Reduced deploy time by 50%.",
      makeSections(["• Reduced deploy time by 50%."]),
      {},
      {},
      { 0: editedText },
      observations,
    );

    // Grouping the edited bullet against the ORIGINAL (un-edited) parsed.experience
    // — the App.tsx mis-wiring that was the original bug.
    const groups = groupBulletsByExperience(
      [obs(0, editedText)],
      parsed.experience,
    );

    // The edited bullet falls into Other — confirming what the user reported.
    expect(groups.find((g) => g.experienceIndex === 0)?.bullets ?? []).toEqual([]);
    expect(groups.find((g) => g.experienceIndex === null)?.bullets).toHaveLength(1);
  });
});

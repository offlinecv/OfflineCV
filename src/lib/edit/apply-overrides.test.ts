// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { applyOverrides, applyProfileOverrides } from "./apply-overrides.ts";
import type { LegacyLinkFields } from "./apply-overrides.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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

  it("applies an experience location override and clears it on empty string", () => {
    const parsed = baseParsed();
    parsed.experience[0].location = "Springfield, IL";
    const { fields: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      { 0: { location: "Santa Clara, CA" } },
      {},
      [],
    );
    expect(out.experience[0].location).toBe("Santa Clara, CA");

    const { fields: cleared } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      { 0: { location: "" } },
      {},
      [],
    );
    expect(cleared.experience[0].location).toBeUndefined();
    // Original untouched.
    expect(parsed.experience[0].location).toBe("Springfield, IL");
  });

  it("applies an experience team override and clears it on empty string", () => {
    const parsed = baseParsed();
    parsed.experience[0].team = "Enterprise Platforms";
    const { fields: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      { 0: { team: "Cloud Infrastructure" } },
      {},
      [],
    );
    expect(out.experience[0].team).toBe("Cloud Infrastructure");

    const { fields: cleared } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      { 0: { team: "" } },
      {},
      [],
    );
    // A cleared team drops off entirely so the render/PDF emits no "· Team".
    expect(cleared.experience[0].team).toBeUndefined();
    // Original untouched.
    expect(parsed.experience[0].team).toBe("Enterprise Platforms");
  });

  it("propagates a bullet edit to rawText, sections, and the matching description", () => {
    const parsed = baseParsed();
    const rawText = "• Built a thing\n• Shipped another thing";
    const sections = makeSections(["• Built a thing", "• Shipped another thing"]);
    const {
      fields: out,
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
    const { fields: out, rawText: outRaw } = applyOverrides(
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

  it("removes a bullet from rawText, sections, and the role description", () => {
    const rawText = "• Built a thing\n• Shipped another thing";
    const {
      fields: out,
      rawText: outRaw,
      sections: outSections,
    } = applyOverrides(
      baseParsed(),
      rawText,
      makeSections(["• Built a thing", "• Shipped another thing"]),
      {},
      {},
      {},
      [obs(0, "Built a thing"), obs(1, "Shipped another thing")],
      {},
      undefined,
      [],
      {},
      new Set([0]),
    );
    expect(outRaw).toBe("• Shipped another thing");
    expect(out.experience[0].description).toBe("Shipped another thing");
    expect(outSections.byName.get("experience")).toEqual([
      "• Shipped another thing",
    ]);
  });

  it("removal is a no-op when the index has no matching observation", () => {
    const rawText = "• Built a thing\n• Shipped another thing";
    const { rawText: outRaw } = applyOverrides(
      baseParsed(),
      rawText,
      makeSections(["• Built a thing", "• Shipped another thing"]),
      {},
      {},
      {},
      [obs(0, "Built a thing")],
      {},
      undefined,
      [],
      {},
      new Set([99]), // index not in observations
    );
    expect(outRaw).toBe(rawText);
  });

  it("is a no-op when overrides are empty", () => {
    const parsed = baseParsed();
    const rawText = "• Built a thing";
    const { fields: out, rawText: outRaw } = applyOverrides(
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
    const { rawText: outRaw, fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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

  it("writes the major (field) override, and a clear drops it to undefined", () => {
    const { fields: set } = applyOverrides(
      eduParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 0: { field: "Computer Science & Engineering" } },
    );
    expect(set.education[0].field).toBe("Computer Science & Engineering");

    const { fields: cleared } = applyOverrides(
      eduParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      { 0: { field: "" } },
    );
    expect(cleared.education[0].field).toBeUndefined();
  });

  it("ignores an education override for an out-of-range index", () => {
    const parsed = eduParsed();
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    const { fields: out } = applyOverrides(
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
    expect(result.fields.experience[0].description).toContain("$50K");

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
      result.fields.experience,
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

describe("applyOverrides — added entries + bullets", () => {
  it("appends an added experience entry with its bullets in the description", () => {
    const parsed = baseParsed();
    const { fields: out } = applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      undefined,
      [
        {
          id: "added:0",
          section: "experience",
          title: "PM",
          subtitle: "Google",
          start_date: "2019",
          end_date: "2021",
        },
      ],
      { "added:0": ["Led a team of five to ship the launch on time"] },
    );
    expect(out.experience).toHaveLength(2);
    expect(out.experience[1]).toMatchObject({
      title: "PM",
      company: "Google",
      description: "Led a team of five to ship the launch on time",
    });
    // Original parse untouched.
    expect(parsed.experience).toHaveLength(1);
  });

  it("appends added education / project / achievement entries to their arrays", () => {
    const { fields: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      undefined,
      [
        { id: "added:0", section: "education", title: "BS CS", subtitle: "MIT" },
        { id: "added:1", section: "projects", title: "Side project" },
        { id: "added:2", section: "achievements", title: "Patent", year: "2021" },
      ],
      {},
    );
    expect(out.education).toHaveLength(1);
    expect(out.education[0]).toMatchObject({ degree: "BS CS", institution: "MIT" });
    expect(out.projects).toHaveLength(1);
    expect(out.projects?.[0]).toMatchObject({ name: "Side project" });
    expect(out.heuristic_achievements).toHaveLength(1);
    expect(out.heuristic_achievements?.[0]).toMatchObject({
      title: "Patent",
      year: "2021",
    });
  });

  it("maps an added achievement's type + title onto the real fields (#455, #456)", () => {
    const { fields: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      undefined,
      [
        {
          id: "added:0",
          section: "achievements",
          achievementType: "Patent",
          title: "Issued US10275736B1; bulk catalog editor",
          year: "2021",
        },
      ],
      {},
    );
    expect(out.heuristic_achievements?.[0]).toMatchObject({
      type: "Patent",
      title: "Issued US10275736B1; bulk catalog editor",
      year: "2021",
    });
  });

  it("adds an achievement with no type as a bare description (#455)", () => {
    const { fields: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      undefined,
      [
        {
          id: "added:0",
          section: "achievements",
          title: "Ran the local 10k for charity",
        },
      ],
      {},
    );
    expect(out.heuristic_achievements?.[0].title).toBe(
      "Ran the local 10k for charity",
    );
  });

  it("folds an added bullet on an existing role into description AND the pool", () => {
    const parsed = baseParsed();
    const { fields: out, sections } = applyOverrides(
      parsed,
      "raw",
      makeSections(["• Built a thing"]),
      {},
      {},
      {},
      [],
      {},
      undefined,
      [],
      { "experience:0": ["Cut latency by 40% across the fleet"] },
    );
    // Appended to the existing role's description.
    expect(out.experience[0].description).toContain(
      "Cut latency by 40% across the fleet",
    );
    // And pooled (with a marker) into the last accomplishment section so it grades.
    const pooled = sections.byName.get("achievements") ?? [];
    expect(pooled).toContain("• Cut latency by 40% across the fleet");
    // Original untouched.
    expect(parsed.experience[0].description).toBe(
      "Built a thing\nShipped another thing",
    );
  });

  it("raises Completeness when an education entry is added (counts toward score)", () => {
    const base = baseParsed();
    const sections = makeSections();
    const before = computeAnonymousAtsScore({
      parsed: base,
      fieldConfidence: {},
      triggers: [],
      rawText: "raw",
      sections,
    });
    const { fields: out, sections: outSections } = applyOverrides(
      base,
      "raw",
      sections,
      {},
      {},
      {},
      [],
      {},
      undefined,
      [{ id: "added:0", section: "education", title: "BS", subtitle: "MIT" }],
      {},
    );
    const after = computeAnonymousAtsScore({
      parsed: out,
      fieldConfidence: {},
      triggers: [],
      rawText: "raw",
      sections: outSections,
    });
    expect(before.completeness.missing).toContain("education");
    expect(after.completeness.missing).not.toContain("education");
    expect(after.completeness.score).toBeGreaterThan(before.completeness.score);
  });
});

// ── Profile links: re-mirror + added extras (#335) ───────────────────────────

/** baseParsed with the four legacy link slots populated (normalized form). */
function parsedWithLinks(): HeuristicParsedResume {
  return {
    ...baseParsed(),
    linkedin_url: "https://linkedin.com/in/jane",
    github_url: "https://github.com/jane",
  };
}

describe("applyOverrides — profiles[] (#335)", () => {
  it("leaves profiles absent when no legacy link and no extras", () => {
    const { fields: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
    );
    expect(out.profiles).toBeUndefined();
  });

  it("re-mirrors profiles from a legacy link correction (never desyncs)", () => {
    const { fields: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        {
          id: "profile:0",
          url: "https://linkedin.com/in/corrected",
          network: "LinkedIn",
          kind: "social",
          legacyKey: "linkedin_url",
        },
      ],
    );
    expect(out.linkedin_url).toBe("https://linkedin.com/in/corrected");
    expect(out.profiles).toEqual([
      {
        url: "https://linkedin.com/in/corrected",
        network: "LinkedIn",
        kind: "social",
      },
    ]);
  });

  it("clearing a legacy link drops it from the mirror", () => {
    const { fields: out } = applyOverrides(
      parsedWithLinks(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        // Clear LinkedIn (empty url correction); GitHub stays.
        {
          id: "profile:0",
          url: "",
          network: "linkedin_url",
          kind: "other",
          legacyKey: "linkedin_url",
        },
      ],
    );
    expect(out.linkedin_url).toBeUndefined();
    expect(out.profiles).toEqual([
      { url: "https://github.com/jane", network: "GitHub", kind: "code" },
    ]);
  });

  it("appends added extras after the legacy slots, in order", () => {
    const { fields: out } = applyOverrides(
      parsedWithLinks(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        { id: "profile:0", url: "https://gitlab.com/jane", network: "GitLab", kind: "code" },
      ],
    );
    expect(out.profiles).toEqual([
      { url: "https://linkedin.com/in/jane", network: "LinkedIn", kind: "social" },
      { url: "https://github.com/jane", network: "GitHub", kind: "code" },
      { url: "https://gitlab.com/jane", network: "GitLab", kind: "code" },
    ]);
  });

  it("keeps an unknown-host extra with its hostname + other kind", () => {
    const { fields: out } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        { id: "profile:0", url: "https://example.dev/jane", network: "example.dev", kind: "other" },
      ],
    );
    expect(out.profiles).toEqual([
      { url: "https://example.dev/jane", network: "example.dev", kind: "other" },
    ]);
  });

  it("de-dupes an extra that repeats a legacy link", () => {
    const { fields: out } = applyOverrides(
      parsedWithLinks(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        { id: "profile:0", url: "https://github.com/jane", network: "GitHub", kind: "code" },
      ],
    );
    expect(out.profiles).toEqual([
      { url: "https://linkedin.com/in/jane", network: "LinkedIn", kind: "social" },
      { url: "https://github.com/jane", network: "GitHub", kind: "code" },
    ]);
  });

  it("does not mutate the input parsed object when re-mirroring", () => {
    const parsed = parsedWithLinks();
    const snapshot = JSON.parse(JSON.stringify(parsed));
    applyOverrides(
      parsed,
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        {
          id: "profile:0",
          url: "https://linkedin.com/in/moved",
          network: "LinkedIn",
          kind: "social",
          legacyKey: "linkedin_url",
        },
      ],
    );
    expect(parsed).toEqual(snapshot);
  });

  // #421 Blocking #1: a LinkedIn/GitHub link added via the guided picker lands
  // in `addedProfiles`, but the scorer + contact gap read the legacy `_url`
  // slot — so the add must back-fill that slot (when empty) and mark it
  // user-affirmed in the edited fieldConfidence, or the score never moves.
  it("back-fills the empty linkedin_url slot from an added LinkedIn profile", () => {
    const { fields: out, fieldConfidence } = applyOverrides(
      baseParsed(), // no legacy linkedin_url
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        {
          id: "profile:0",
          url: "https://linkedin.com/in/jane",
          network: "LinkedIn",
          kind: "social",
        },
      ],
    );
    expect(out.linkedin_url).toBe("https://linkedin.com/in/jane");
    expect(fieldConfidence.linkedin_url).toBe(1);
  });

  it("does NOT overwrite an existing legacy slot when back-filling", () => {
    const { fields: out } = applyOverrides(
      parsedWithLinks(), // linkedin_url already set to .../in/jane
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        {
          id: "profile:0",
          url: "https://linkedin.com/in/someone-else",
          network: "LinkedIn",
          kind: "social",
        },
      ],
    );
    expect(out.linkedin_url).toBe("https://linkedin.com/in/jane");
  });

  // #421 Blocking #3: a typed-in contact edit is user-affirmed → confidence 1;
  // an explicit clear → 0; an untouched field keeps its base confidence.
  it("bumps edited contact-field confidence and drops a cleared one", () => {
    const { fieldConfidence } = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      { email: "" }, // clear email (non-link contact field)
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [],
      {},
      new Set(),
      [
        // GitHub correction (a link edit) — affirmed → confidence 1.
        {
          id: "profile:0",
          url: "https://github.com/jane",
          network: "GitHub",
          kind: "code",
          legacyKey: "github_url",
        },
      ],
      { full_name: 0.9, email: 0.9 },
    );
    expect(fieldConfidence.github_url).toBe(1); // affirmed
    expect(fieldConfidence.email).toBe(0); // cleared
    expect(fieldConfidence.full_name).toBe(0.9); // untouched base kept
  });

  // #427 review Secondary #1: a correction that CLEARS a legacy slot plus an
  // extra that back-fills the SAME slot must collapse to ONE confEdit (the
  // extra's confidence 1) — not two. A downstream consumer reads the returned
  // list via `.find(e => e.key === …)`, which returns the FIRST match; a
  // duplicate {conf:0} before {conf:1} would make it read the link as absent
  // while the slot is present, desyncing score from display.
  it("returns one confEdit per legacy slot (clear + same-slot add → last wins)", () => {
    const probe: LegacyLinkFields = { linkedin_url: "https://linkedin.com/in/old" };
    const confEdits = applyProfileOverrides(probe, [
      // correction: clear the detected LinkedIn
      { id: "p0", url: "", network: "LinkedIn", kind: "social", legacyKey: "linkedin_url" },
      // extra: add a new LinkedIn (no legacyKey) → back-fills the now-empty slot
      { id: "p1", url: "https://linkedin.com/in/new", network: "LinkedIn", kind: "social" },
    ]);
    const linkedinEdits = confEdits.filter((e) => e.key === "linkedin_url");
    expect(linkedinEdits).toHaveLength(1);
    expect(linkedinEdits[0].confidence).toBe(1); // present, not the stale clear
    expect(probe.linkedin_url).toBe("https://linkedin.com/in/new");
  });
});

// ── Achievements (#454) ─────────────────────────────────────────────────────
//
// `title` is the canonical field: the UI edits its two halves (the leading type
// label and the description) as separate fields and applyOverrides recomposes
// them, so these tests pin the decompose → edit → recompose loop, including the
// degenerate shapes (no type segment, a cleared type, an over-long type).

/** A parse carrying two parsed achievements — one typed, one prose-only. */
function achParsed(): HeuristicParsedResume {
  return {
    ...baseParsed(),
    heuristic_achievements: [
      {
        type: "Patent",
        title: "Issued US10275736B1; bulk catalog editor",
        year: "2019",
        description: "Cut editor latency 40%",
      },
      { title: "Best Paper Award", year: "2021" },
    ],
  };
}

/** applyOverrides with only the achievement overrides (+ optional added entries)
 *  set — the rest defaulted, so the calls below stay readable. */
function applyAch(
  parsed: HeuristicParsedResume,
  achievements: Parameters<typeof applyOverrides>[14],
  addedEntries: Parameters<typeof applyOverrides>[9] = [],
) {
  return applyOverrides(
    parsed,
    "raw",
    makeSections(),
    {},
    {},
    {},
    [],
    {},
    undefined,
    addedEntries,
    {},
    undefined,
    undefined,
    undefined,
    achievements,
  );
}

describe("applyOverrides — achievements", () => {
  it("writes the title override onto the title field, leaving the type alone", () => {
    const parsed = achParsed();
    const { fields: out } = applyAch(parsed, {
      0: { title: "Issued US10275736B1; bulk catalog editor v2" },
    });
    expect(out.heuristic_achievements?.[0]).toMatchObject({
      type: "Patent",
      title: "Issued US10275736B1; bulk catalog editor v2",
    });
    // The original parse is not mutated.
    expect(parsed.heuristic_achievements?.[0].title).toBe(
      "Issued US10275736B1; bulk catalog editor",
    );
  });

  it("writes the type override onto the type field (the bold run tracks it)", () => {
    const { fields: out } = applyAch(achParsed(), { 0: { type: "Publication" } });
    expect(out.heuristic_achievements?.[0]).toMatchObject({
      type: "Publication",
      title: "Issued US10275736B1; bulk catalog editor",
    });
  });

  it("clearing the type drops the field, keeping the title intact", () => {
    const { fields: out } = applyAch(achParsed(), { 0: { type: "" } });
    expect(out.heuristic_achievements?.[0].type).toBeUndefined();
    expect(out.heuristic_achievements?.[0].title).toBe(
      "Issued US10275736B1; bulk catalog editor",
    );
  });

  it("adds a type to a previously type-less achievement", () => {
    const { fields: out } = applyAch(achParsed(), { 1: { type: "Award" } });
    expect(out.heuristic_achievements?.[1]).toMatchObject({
      type: "Award",
      title: "Best Paper Award",
    });
  });

  it("edits the title of a type-less achievement without inventing a type", () => {
    const { fields: out } = applyAch(achParsed(), {
      1: { title: "Best Paper Award, ACL" },
    });
    expect(out.heuristic_achievements?.[1].type).toBeUndefined();
    expect(out.heuristic_achievements?.[1].title).toBe("Best Paper Award, ACL");
  });

  it("sets the year, and an empty year clears it", () => {
    const { fields: set } = applyAch(achParsed(), { 1: { year: "2022" } });
    expect(set.heuristic_achievements?.[1].year).toBe("2022");

    const { fields: cleared } = applyAch(achParsed(), { 1: { year: "" } });
    expect(cleared.heuristic_achievements?.[1].year).toBeUndefined();
  });

  it("clearing both fields empties the header without cross-contamination", () => {
    const { fields: out } = applyAch(achParsed(), { 0: { type: "", title: "" } });
    expect(out.heuristic_achievements?.[0].type).toBeUndefined();
    expect(out.heuristic_achievements?.[0].title).toBe("");
  });

  it("keeps the achievement's bullets (description body) across a header edit", () => {
    const { fields: out } = applyAch(achParsed(), { 0: { type: "Publication" } });
    expect(out.heuristic_achievements?.[0].description).toBe(
      "Cut editor latency 40%",
    );
  });

  // ── The two shapes the old composed-title model (#454) got wrong ────────────
  // Both used to survive as a `title` STRING but re-split into a different pair,
  // so the PDF bolded the wrong run and /jd-fit showed the wrong fields. With
  // `type` a real field there is nothing to re-split (#456).

  it("keeps an over-long type as the type — it is not folded into the title", () => {
    const longType = "Recognized across the org for sustained impact";
    const { fields: out } = applyAch(achParsed(), { 1: { type: longType } });
    expect(out.heuristic_achievements?.[1]).toMatchObject({
      type: longType,
      title: "Best Paper Award",
    });
  });

  it("keeps a title carrying its own separator out of the type", () => {
    const { fields: out } = applyAch(achParsed(), {
      1: { type: "Talk", title: "KubeCon · Amsterdam" },
    });
    expect(out.heuristic_achievements?.[1]).toMatchObject({
      type: "Talk",
      title: "KubeCon · Amsterdam",
    });
  });

  it("ignores an achievement override for an out-of-range index", () => {
    const { fields: out } = applyAch(achParsed(), { 5: { type: "Patent" } });
    expect(out.heuristic_achievements).toHaveLength(2);
    expect(out.heuristic_achievements?.[0].type).toBe("Patent");
  });

  it("is a no-op when there are no achievement overrides", () => {
    const { fields: out } = applyAch(achParsed(), {});
    expect(out.heuristic_achievements).toEqual(achParsed().heuristic_achievements);
  });

  it("survives an override against a parse with no achievements at all", () => {
    const { fields: out } = applyAch(baseParsed(), { 0: { type: "Patent" } });
    expect(out.heuristic_achievements).toBeUndefined();
  });

  it("keys overrides against the PARSED indices — an added achievement never collides", () => {
    const { fields: out } = applyAch(
      achParsed(),
      { 0: { type: "Publication" } },
      [{ id: "added:0", section: "achievements", title: "Talk", year: "2024" }],
    );
    expect(out.heuristic_achievements).toHaveLength(3);
    expect(out.heuristic_achievements?.[0]).toMatchObject({
      type: "Publication",
      title: "Issued US10275736B1; bulk catalog editor",
    });
    // The appended entry sits past the parsed ones, untouched by the override.
    expect(out.heuristic_achievements?.[2]).toMatchObject({
      title: "Talk",
      year: "2024",
    });
  });
});

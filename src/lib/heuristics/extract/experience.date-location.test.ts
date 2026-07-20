// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for a `Date · Location` experience sub-line (#347).
 *
 * When a role's date anchor line carries a trailing " · Location" (two-column
 * Google-Docs exports write "Jan 2022 – Present · Springfield, IL"), stripping
 * the date range off the front leaves a dangling LEADING "·" ("· Springfield,
 * IL"). Before the fix that orphaned "·" survived the whitespace-both-sides
 * header split, clobbered the company/team assignment, and — for a multi-word
 * city — mis-split the location ("Initech" lost; company="· Pacific";
 * location="Coast, CA"). The location must route cleanly and the company must
 * survive intact.
 *
 * Synthetic personas only, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { groupIntoLines, splitIntoSections, findSection } from "../sections.ts";
import { extractExperience } from "../extract-fields.ts";
import { mkItems } from "../__test-utils__/mkItem.ts";

function roleFromSection(specs: Array<{ text: string; fontSize?: number }>) {
  const sections = splitIntoSections(groupIntoLines(mkItems(specs)));
  const experience = findSection(sections, "experience");
  expect(experience).toBeDefined();
  return extractExperience(experience).value;
}

describe("date · location experience sub-line (#347)", () => {
  it("routes a single-word city to location, not team", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp — Senior Software Engineer", fontSize: 11 },
      { text: "Jan 2022 – Present · Springfield, IL", fontSize: 11 },
      { text: "• Led migration of core services to Kubernetes.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].company).toBe("Acme Corp");
    expect(roles[0].title).toBe("Senior Software Engineer");
    expect(roles[0].location).toBe("Springfield, IL");
    expect(roles[0].team).toBeUndefined();
  });

  it("keeps company intact and location whole for a multi-word city", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Initech — Junior Engineer", fontSize: 11 },
      { text: "Aug 2017 – Feb 2019 · Pacific Coast, CA", fontSize: 11 },
      { text: "• Built internal tooling used across three teams.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    // Before the fix: company="· Pacific", location="Coast, CA", "Initech" lost.
    expect(roles[0].company).toBe("Initech");
    expect(roles[0].title).toBe("Junior Engineer");
    expect(roles[0].location).toBe("Pacific Coast, CA");
    expect(roles[0].company).not.toContain("·");
  });
});

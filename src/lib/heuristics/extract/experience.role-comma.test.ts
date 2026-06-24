// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression for the `"Title, Location"` role-comma split (PR #159 review):
 * `splitRoleComma` must split `"Role, Company"` headers (the chanchal Word
 * template form) but NOT split `"Title, City"` headers — otherwise a city is
 * recorded as the company. Synthetic personas only, per the fixtures PII policy.
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

describe("splitRoleComma — Title, Location must not become Title, Company", () => {
  it("splits a real 'Role, Company' header (no legal suffix)", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Office manager, Nod Publishing", fontSize: 11 },
      { text: "March 2023 - December 2024", fontSize: 11 },
      { text: "• Ran the front office for a 40-person team.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].title.toLowerCase()).toContain("office manager");
    expect(roles[0].company).toContain("Nod Publishing");
  });

  it("does NOT record a bare city as the company for 'Title, City'", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Marketing Manager, San Francisco", fontSize: 11 },
      { text: "January 2022 - Present", fontSize: 11 },
      { text: "• Owned the demand-gen funnel end to end.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].company).not.toContain("San Francisco");
  });

  it("does NOT record a 'City, ST' tail as the company", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Product Designer, Austin, TX", fontSize: 11 },
      { text: "June 2020 - December 2021", fontSize: 11 },
      { text: "• Shipped a redesigned onboarding flow.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].company).not.toMatch(/Austin/);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression tests for multi-word city extraction on a space-folded header
 * (#368).
 *
 * A right-aligned location rail folds onto the company line with no comma
 * between company and city:
 *
 *   "Greenfield Studios      New York, NY"   → one PdfLine
 *
 * The location strip's single-token space pass (Pass B) captured only the last
 * word before the comma ("York, NY"), leaving the city's leading word glued to
 * the company ("Greenfield Studios New"). Single-word cities ("Bellevue, WA")
 * were unaffected — only multi-word cities broke. A closed-vocabulary multi-word
 * pass (KNOWN_MULTIWORD_US_CITY_RE) now captures the whole city.
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

describe("multi-word city on space-folded header (#368)", () => {
  it("keeps a multi-word city whole and off the company", () => {
    // "Greenfield Studios  New York, NY" folds company + right-rail location
    // onto one line (the exact shape from the LaTeX fixture, entries 3–4).
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Greenfield Studios New York, NY", fontSize: 11 },
      { text: "Software Engineering Intern", fontSize: 11 },
      { text: "May 2023 - Jun. 2023", fontSize: 11 },
      { text: "• Built a document generator on a hosted LLM API.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Greenfield Studios");
    expect(role.location).toBe("New York, NY");
    // The city's leading word must not leak into the company.
    expect(role.company).not.toContain("New");
    expect(role.title?.toLowerCase()).toContain("intern");
  });

  it("still extracts a single-word city (no regression to Pass B)", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Northwind Labs Bellevue, WA", fontSize: 11 },
      { text: "Software Engineering Intern", fontSize: 11 },
      { text: "Sep. 2025 - Apr. 2026", fontSize: 11 },
      { text: "• Trained fraud classifiers on an internal ML platform.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Northwind Labs");
    expect(role.location).toBe("Bellevue, WA");
  });

  it("does not fragment a company that merely contains a city word", () => {
    // "New York Times" is a company, not a location — with no ", ST" state tail
    // the strip must leave it whole.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "The New York Times", fontSize: 11 },
      { text: "Software Engineer", fontSize: 11 },
      { text: "Jan. 2022 - Present", fontSize: 11 },
      { text: "• Shipped a newsroom analytics dashboard.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("The New York Times");
    expect(role.location).toBeUndefined();
  });
});

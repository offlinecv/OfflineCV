// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

// Companion coverage to #368/#347: those covered the two-column space-fold
// `Company City, ST` shape. #616 is the same "multi-word bare city" weakness on
// the single-line MIDDOT header path: `Title · Company, City · Team` where the
// city carries NO state/country suffix — the closed BARE_LOCATION_RE vocab (Pass
// F of stripLocationSuffix) knows single-word "Hyderabad" but not multi-word
// "Mountain View", so the middle segment stayed whole and `company` swallowed
// the city. Fixed by adding Mountain View (a canonical tech-hub example) to the
// single-source MULTIWORD_US_CITY_ALT vocab so BARE_LOCATION_RE full-matches it.
// The trailing-segment case is covered too so behavior is position-independent.
describe("multi-word city without state/country suffix on middot header (#616)", () => {
  it("row (b) — middle segment: `Company, MultiWordCity` splits into company + location", () => {
    // "Google, Mountain View" sits in the MIDDLE middot segment. Before the fix
    // the whole string landed in `company` and `location` dropped.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Engineering Lead · Google, Mountain View · GFiber",
        fontSize: 11,
      },
      { text: "04/2021 – 12/2023", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title?.toLowerCase()).toContain("engineering lead");
    expect(role.company).toBe("Google");
    expect(role.location).toBe("Mountain View");
    expect(role.team).toBe("GFiber");
  });

  it("row (a) unchanged — middle `Company, MultiWordCity, ST` still splits with state suffix", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Engineering Lead · Google, Mountain View, CA · GFiber",
        fontSize: 11,
      },
      { text: "04/2021 – 12/2023", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Mountain View, CA");
    expect(role.team).toBe("GFiber");
  });

  it("row (c) unchanged — middle `Company, SingleWordCity` in existing bare-location vocab still splits", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Google, Hyderabad · Enterprise Platforms",
        fontSize: 11,
      },
      { text: "04/2021 – 12/2023", fontSize: 11 },
      { text: "• Ran a cross-team migration to a shared platform.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Hyderabad");
    expect(role.team).toBe("Enterprise Platforms");
  });

  it("row (d) unchanged — trailing `Company, SingleWordCity` still splits", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Google, Hyderabad",
        fontSize: 11,
      },
      { text: "04/2021 – 12/2023", fontSize: 11 },
      { text: "• Ran a cross-team migration to a shared platform.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Hyderabad");
  });

  it("position-independence — trailing `Company, MultiWordCity` splits the same way as middle", () => {
    // The acceptance criteria's core structural requirement: splitting behaviour
    // does not depend on the segment's position in the header.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Google, Mountain View",
        fontSize: 11,
      },
      { text: "04/2021 – 12/2023", fontSize: 11 },
      { text: "• Ran a cross-team migration to a shared platform.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Mountain View");
  });
});

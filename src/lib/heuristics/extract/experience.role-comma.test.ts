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

/**
 * Regression for the #325 step-5 (`title`→`location`) rescue false-positive
 * class (adversarial review): a comma-formatted job title whose role word is
 * OUTSIDE the finite `looksLikeTitle` keyword list ("Buyer", "Merchandiser",
 * "Barista", "Owner") full-matched the shape-only INTL_LOCATION_RE branch and
 * was silently erased into `location` — genuine title dropped. The step-5
 * rescue must fire ONLY on a genuine bare location (valid state code / real
 * country), never on a Title-Case-pair job title. Synthetic personas only.
 */
describe("step-5 title→location rescue must not erase comma-formatted titles", () => {
  const cases: Array<{ title: string; not: RegExp }> = [
    { title: "Buyer, Home Goods", not: /Home Goods/ },
    { title: "Merchandiser, Footwear", not: /Footwear/ },
    { title: "Barista, Downtown Store", not: /Downtown Store/ },
    { title: "Product Owner, Growth Team", not: /Growth Team/ },
  ];
  for (const { title, not } of cases) {
    it(`keeps "${title}" as the title, not the location`, () => {
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: title, fontSize: 11 },
        { text: "Big Box Retailer Co.", fontSize: 11 },
        { text: "January 2020 - March 2022", fontSize: 11 },
        { text: "• Owned the category assortment end to end.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      // The role word survives as the title …
      expect(roles[0].title).toBe(title);
      // … and is NOT dumped into location.
      expect(roles[0].location ?? "").not.toMatch(not);
    });
  }
});

/**
 * Regression for the round-2 review: the SAME #325 shape-only false-positive
 * class reached through the `team` slot instead of `title`. In a 3-segment
 * middot header "Title · Company · Sub-team", the third segment lands in `team`;
 * the step-3b `team`→location rescue used a raw shape-only `.test()` on
 * US_LOCATION_RE / INTL_LOCATION_RE, so a comma-formatted sub-team/department
 * ("Buyer, Home Goods") full-matched INTL_LOCATION_RE and was silently erased
 * into `location`. Step 3b now routes through the shared closed-vocab
 * `isBareLocationString`, so a generic Title-Case tail stays a team while a real
 * "City, ST" / "City, Country" third segment is still rescued to location.
 * Synthetic personas only, per the fixtures PII policy.
 */
describe("step-3b team→location rescue: closed-vocab, not shape-only", () => {
  it("does NOT erase a 'Buyer, Home Goods' sub-team into location", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Merchandising · Acme Corp · Buyer, Home Goods", fontSize: 11 },
      { text: "January 2020 - March 2022", fontSize: 11 },
      { text: "• Owned the category assortment end to end.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    // Sub-team content survives — not swallowed into location.
    expect(roles[0].location ?? "").not.toMatch(/Home Goods/);
    expect(roles[0].team ?? "").toContain("Buyer, Home Goods");
  });

  it("does NOT erase a 'Product Owner, Growth Team' sub-team into location", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Engineering · Acme Corp · Product Owner, Growth Team", fontSize: 11 },
      { text: "February 2019 - August 2021", fontSize: 11 },
      { text: "• Drove the platform roadmap.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].location ?? "").not.toMatch(/Growth Team/);
    expect(roles[0].team ?? "").toContain("Product Owner, Growth Team");
  });

  it("STILL rescues a genuine 'City, ST' third segment to location", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Software Engineer · Acme Corp · Austin, TX", fontSize: 11 },
      { text: "March 2021 - Present", fontSize: 11 },
      { text: "• Built the ingestion pipeline.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].location).toBe("Austin, TX");
    // Not left dangling in team.
    expect(roles[0].team ?? "").not.toMatch(/Austin/);
  });

  it("STILL rescues a genuine 'City, Country' third segment to location", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Software Engineer · Acme Corp · Bangalore, India", fontSize: 11 },
      { text: "March 2021 - Present", fontSize: 11 },
      { text: "• Built the ingestion pipeline.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].location).toBe("Bangalore, India");
    expect(roles[0].team ?? "").not.toMatch(/Bangalore/);
  });
});

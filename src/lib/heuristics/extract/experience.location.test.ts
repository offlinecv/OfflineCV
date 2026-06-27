// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression tests for role location extraction (#218).
 *
 * Covers two header shapes where `City, ST` was previously swallowed or
 * mis-routed:
 *
 *   1. Two-line header: "Company  DATE" / "Title  City, ST"
 *      — city and state were split at the comma, city glued to title,
 *        state code mis-routed into `team`.
 *
 *   2. Single-line `·`-delimited header: "Title · Company, City, ST · Team"
 *      — location embedded in company; `location` stayed null.
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

describe("role location extraction (#218)", () => {
  describe("two-line header — trailing City, ST on title line", () => {
    it("extracts location from title line, title is clean, team is not a state code", () => {
      // Reproduces the exact shape from the issue:
      //   "Acme Corp  Sep 2025 – Apr 2026" (company + date line)
      //   "Software Engineering Intern on the Risk Team   Bellevue, WA" (title + location)
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Acme Corp", fontSize: 11 },
        { text: "Sep. 2025 - Apr. 2026", fontSize: 11 },
        {
          text: "Software Engineering Intern on the Risk Team   Bellevue, WA",
          fontSize: 11,
        },
        { text: "• Automated risk-scoring pipeline for 1M accounts.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];

      // Title must be free of location text
      expect(role.title).not.toContain("Bellevue");
      expect(role.title).not.toContain("WA");
      expect(role.title.toLowerCase()).toContain("intern");

      // company unchanged
      expect(role.company).toContain("Acme Corp");

      // team must NOT be "WA" (state code must not route into team)
      expect(role.team).not.toBe("WA");

      // location extracted
      expect(role.location).toBe("Bellevue, WA");
    });

    it("handles Pacific Northwest city with 2-letter state code", () => {
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Sigma Technologies", fontSize: 11 },
        { text: "Mar. 2022 - Dec. 2023", fontSize: 11 },
        { text: "Senior Software Engineer Portland, OR", fontSize: 11 },
        { text: "• Reduced deployment time by 60%.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];

      expect(role.title).not.toContain("Portland");
      expect(role.title).not.toContain("OR");
      expect(role.location).toBe("Portland, OR");
      expect(role.team).toBeUndefined();
    });
  });

  describe("mid-dot (·) header — City, ST embedded in company", () => {
    it("strips location from company: three-segment header", () => {
      // "Senior Staff Engineer · Acme Corp, Springfield, IL · Platform Team"
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        {
          text: "Senior Staff Engineer · Acme Corp, Springfield, IL · Platform Team",
          fontSize: 11,
        },
        { text: "01/2019 - 02/2022", fontSize: 11 },
        { text: "• Reduced p99 latency 43% by migrating the service mesh.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];

      expect(role.title.toLowerCase()).toContain("engineer");
      // Company must be clean — no location text
      expect(role.company).toBe("Acme Corp");
      expect(role.company).not.toContain("Springfield");
      // Team intact
      expect(role.team).toBe("Platform Team");
      // Location extracted
      expect(role.location).toBe("Springfield, IL");
    });

    it("strips location from company: two-segment header (no team)", () => {
      // "Software Engineer · Beta Systems, Seattle, WA"
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Software Engineer · Beta Systems, Seattle, WA", fontSize: 11 },
        { text: "05/2016 - 12/2018", fontSize: 11 },
        { text: "• Built analytics pipeline processing 2M events/day.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];

      expect(role.title.toLowerCase()).toContain("engineer");
      expect(role.company).toBe("Beta Systems");
      expect(role.company).not.toContain("Seattle");
      expect(role.team).toBeUndefined();
      expect(role.location).toBe("Seattle, WA");
    });

    it("strips location from company: founder role (Meridian Labs, Chicago, IL)", () => {
      // "Founder & CEO · Meridian Labs, Chicago, IL · Executive Team"
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        {
          text: "Founder & CEO · Meridian Labs, Chicago, IL · Executive Team",
          fontSize: 11,
        },
        { text: "03/2022 - Present", fontSize: 11 },
        { text: "• Scaled platform from 0 to 50k MAU.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];

      expect(role.title.toLowerCase()).toMatch(/founder|ceo/);
      expect(role.company).toBe("Meridian Labs");
      expect(role.company).not.toContain("Chicago");
      expect(role.team).toBe("Executive Team");
      expect(role.location).toBe("Chicago, IL");
    });
  });

  describe("multi-word city in comma-delimited 'Company, City, ST' tail", () => {
    it("keeps a two-word city intact (Mountain View, not just View)", () => {
      // Regression: single-token city rule truncated "Mountain View" to "View"
      // and glued "Mountain" onto company ("Google, Mountain" / "View, CA").
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Engineering Lead · Google, Mountain View, CA", fontSize: 11 },
        { text: "01/2018 - 12/2020", fontSize: 11 },
        { text: "• Led the GFiber platform team.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];
      expect(role.company).toBe("Google");
      expect(role.company).not.toContain("Mountain");
      expect(role.location).toBe("Mountain View, CA");
    });

    it("keeps a two-word city intact with a legal-suffix company (Santa Clara)", () => {
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Founder & CEO · Northstar Labs Inc., Santa Clara, CA", fontSize: 11 },
        { text: "03/2022 - Present", fontSize: 11 },
        { text: "• Scaled platform from 0 to 50k MAU.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];
      expect(role.company).toBe("Northstar Labs Inc.");
      expect(role.company).not.toContain("Santa");
      expect(role.location).toBe("Santa Clara, CA");
    });
  });

  describe("no-regression: valid company names with commas are not stripped", () => {
    it("does not strip 'Inc' from 'Acme, Inc' (legal suffix guard)", () => {
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Software Engineer", fontSize: 11 },
        { text: "Jan 2020 - Present", fontSize: 11 },
        { text: "Acme, Inc.", fontSize: 11 },
        { text: "• Owned the core API.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];
      // "Inc." must remain in company; must not be misread as location
      expect(role.company).toContain("Acme");
      expect(role.location).toBeUndefined();
    });

    it("does not strip a company that has only one word before the US city (avoids over-stripping)", () => {
      // "MegaCorp, Austin, TX" — only one company word before the city.
      // stripLocationSuffix should strip ", Austin, TX" so company = "MegaCorp".
      const roles = roleFromSection([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Software Engineer", fontSize: 11 },
        { text: "Jan 2022 - Present", fontSize: 11 },
        { text: "MegaCorp, Austin, TX", fontSize: 11 },
        { text: "• Shipped core payment APIs.", fontSize: 11 },
      ]);
      expect(roles.length).toBeGreaterThanOrEqual(1);
      const role = roles[0];
      // Company must not contain location text
      expect(role.company).toBe("MegaCorp");
      expect(role.location).toBe("Austin, TX");
    });
  });
});

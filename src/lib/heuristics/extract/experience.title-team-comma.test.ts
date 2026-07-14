// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression for #372 — a "Title, Team" role header over a
 * "Company | Location Dates" anchor line.
 *
 *   Software Engineer II, Business Credit Journey
 *   Globex Financial | New York, NY  August 2024 - Present
 *
 * The comma suffix "Business Credit Journey" is an internal TEAM, and the real
 * employer "Globex Financial" sits on the next (date-anchor) line. Neither reads
 * as a company by `looksLikeCompany` (no legal suffix), so disambiguation fell to
 * the title-keyword tiebreak, which blindly assigned the post-comma segment as
 * the company (`company = "Business Credit Journey"`) and demoted the real
 * employer to `team`. The fix routes the post-comma segment to `team` and takes
 * the company from the delimited anchor line's leading segment.
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

describe("'Title, Team' over 'Company | Location Dates' (#372)", () => {
  it("maps the post-comma segment to team and the anchor-line org to company", () => {
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Software Engineer II, Business Credit Journey", fontSize: 11 },
      {
        text: "Globex Financial | New York, NY August 2024 - Present",
        fontSize: 11,
      },
      { text: "• Ran Cassandra design sessions with technical leads.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title).toBe("Software Engineer II");
    expect(role.company).toBe("Globex Financial");
    expect(role.team).toBe("Business Credit Journey");
    // The team must not be mislabeled as the company.
    expect(role.company).not.toContain("Business Credit Journey");
    // #373 recovers the anchor line's location ("New York, NY"): it sits BEFORE
    // the stripped date range, so `locationFromAnchorCell` claims it from the
    // pipe cell. (Was pinned `toBeUndefined()` as a known gap until #373 landed.)
    expect(role.location).toBe("New York, NY");
  });

  it("still maps a genuine 'Title, Company' with a plain date line below (no regression)", () => {
    // Pure-date anchor line (no delimiter → no company segment), so the fix must
    // NOT fire: the comma suffix stays the company.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Office manager, Nod Publishing", fontSize: 11 },
      { text: "March 2023 - December 2024", fontSize: 11 },
      { text: "• Ran the front office for a 40-person team.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title.toLowerCase()).toContain("office manager");
    expect(role.company).toBe("Nod Publishing");
  });
});

/**
 * Regression for #466 — the INVERSE anchor placement of #372: the DATE sits on the
 * "Title, Team" line itself, with the employer on the NEXT line:
 *
 *   Product Designer, Growth      Jan 2020 - Dec 2021
 *   Acme | Chicago, IL  Design
 *
 * Because the date-bearing anchor is the title line, `mapTitleFirst` read that
 * line's own comma segments as the company and mirrored the title into `company`
 * (a suffix-less employer like "Acme" never triggers `looksLikeCompany`, so it
 * fell to this branch); `location`, sitting on the employer line, was dropped by
 * both the company-correct path AND the mirror path. The fix reads the company off
 * the separate employer line, recovers a leading `City, ST` from that line, and
 * backstops `company === title` to an honest miss.
 */
describe("'Title, Team <dates>' over a next-line employer (#466)", () => {
  it("reads the company + location off the next line for a suffix-less employer (no mirror)", () => {
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Product Designer, Growth  Jan 2020 - Dec 2021", fontSize: 11 },
      { text: "Acme | Chicago, IL  Design", fontSize: 11 },
      { text: "• Shipped the onboarding redesign.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title).toBe("Product Designer");
    expect(role.company).toBe("Acme");
    expect(role.team).toBe("Growth");
    expect(role.location).toBe("Chicago, IL");
    // The title is never mirrored into the company.
    expect(role.company).not.toBe(role.title);
  });

  it("recovers the employer-line location even when the company already resolved (suffixed)", () => {
    // "Northwind Systems" carries a company suffix, so `company` was already
    // correct — but `location` on the employer line (before a trailing dept) was
    // still dropped. This pins the location half of the fix independently.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Software Engineer II, Payments Platform  Aug 2024 - Present", fontSize: 11 },
      { text: "Northwind Systems | Chicago, IL  Consumer Banking", fontSize: 11 },
      { text: "• Led the platform reliability program.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title).toBe("Software Engineer II");
    expect(role.company).toBe("Northwind Systems");
    expect(role.team).toBe("Payments Platform");
    expect(role.location).toBe("Chicago, IL");
    expect(role.company).not.toBe(role.title);
  });

  it("prefers an absent company over a mirrored title when no employer line exists", () => {
    // A standalone "Title, Team <dates>" with no employer line and no shared-
    // employer banner: the company genuinely cannot be read, so it must be a miss
    // (empty), never the title mirrored back.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Data Analyst, Growth Squad  Feb 2021 - Dec 2022", fontSize: 11 },
      { text: "• Built the retention dashboard.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title).toBe("Data Analyst");
    expect(role.company).not.toBe(role.title);
    expect(role.company).toBe("");
  });
});

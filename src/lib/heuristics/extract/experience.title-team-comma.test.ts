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
    // Known gap: the anchor line's location ("New York, NY") is dropped on this
    // shape — the location sits BEFORE the (stripped) date range, so no
    // end-anchored pass claims it. Deferred to #373; pinned here so #373's fix
    // flips a visible assertion rather than silently changing untested behavior.
    expect(role.location).toBeUndefined();
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

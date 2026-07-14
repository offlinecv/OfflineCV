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

describe("'Title, Team [dates]' over 'Company | Location' below-anchor employer (#466)", () => {
  it("takes the company from the below-anchor delim-split and demotes post-comma to team", () => {
    // The anchor line is the "Title, Team [dates]" comma-split itself. Neither
    // the title, the team, nor the employer carries a company-suffix, so the
    // parser falls into `mapTitleFirst`. Pre-#466 the anchor-line comma-split's
    // first segment was mirrored into `company`; post-#466, the leading
    // delim-split of the line BELOW the anchor is the company.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      {
        text: "Software Engineer II, Payments Platform Aug 2024 - Present",
        fontSize: 11,
      },
      { text: "Wingtip Financial | Chicago, IL", fontSize: 11 },
      { text: "• Owned the settlement rails.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.title).toBe("Software Engineer II");
    expect(role.company).toBe("Wingtip Financial");
    expect(role.team).toBe("Payments Platform");
    expect(role.location).toBe("Chicago, IL");
  });

  it("company is never byte-equal to title (#466 backstop)", () => {
    // Anchor line IS the "Title, Team [dates]" comma-split itself, with NO
    // below-anchor employer line — the exact shape where pre-#466 the parser
    // mirrored the title into `company`. The end-of-pipeline
    // `company === title` backstop clears it so the miss reads honestly as
    // empty (parse1 has `company === ""`) rather than as bad data.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      {
        text: "Product Analyst, Growth Insights  Jul 2021 - Present",
        fontSize: 11,
      },
      { text: "• Ran the growth experimentation program.", fontSize: 11 },
    ]);
    const role = roles[0];
    expect(role.title).toContain("Product Analyst");
    // The critical invariant: company is never byte-equal to title.
    expect(role.company).not.toBe(role.title);
    // The post-comma segment lands in `team`, so it's still recoverable.
    expect(role.team).toBe("Growth Insights");
  });

  it("case 3a promotes when the post-comma ends in a LEGAL-ENTITY marker (PR #483 review)", () => {
    // "Software Engineer, Ridgemont Holdings" ends in `Holdings` — an
    // unambiguous legal-entity marker in the narrowed COMPANY_LEGAL_TAIL_RE
    // vocab. Promote to company; team is undefined; no mirror + backstop.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      {
        text: "Software Engineer, Ridgemont Holdings  Aug 2022 - Present",
        fontSize: 11,
      },
      { text: "• Owned the analytics service.", fontSize: 11 },
    ]);
    const role = roles[0];
    expect(role.title).toBe("Software Engineer");
    expect(role.company).toBe("Ridgemont Holdings");
    expect(role.team).toBeUndefined();
  });

  it("case 3a does NOT fire on team-shape post-comma like 'Growth Analytics' (PR #483 review)", () => {
    // The pre-narrowing broad vocab promoted `Growth Analytics` to company
    // and dropped `team`, which then blocked the #382 shared-employer banner
    // from being inherited (isBannerContinuation early-returns on !team).
    // The narrowed COMPANY_LEGAL_TAIL_RE excludes `Analytics`, so the role
    // falls to case 3 (mirror + backstop) and the banner propagator inherits
    // the shared employer correctly.
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Wingtip Financial Inc.", fontSize: 11 },
      {
        text: "Staff Engineer, Platform Infrastructure  Aug 2024 - Present",
        fontSize: 11,
      },
      { text: "• Led the platform reliability program.", fontSize: 11 },
      {
        text: "Senior Engineer, Growth Analytics  Jul 2022 - Aug 2024",
        fontSize: 11,
      },
      { text: "• Built the growth-experiment platform.", fontSize: 11 },
    ]);
    expect(roles).toHaveLength(2);
    // Role 1 anchors the banner directly.
    expect(roles[0].company).toBe("Wingtip Financial Inc.");
    expect(roles[0].team).toBe("Platform Infrastructure");
    // Role 2's `Growth Analytics` MUST stay as team (not promoted to company),
    // so the banner propagator finds !entry.team=false → isBannerContinuation
    // considers it → inherits `Wingtip Financial Inc.` as company.
    expect(roles[1].company).toBe("Wingtip Financial Inc.");
    expect(roles[1].team).toBe("Growth Analytics");
    expect(roles[1].title).toBe("Senior Engineer");
  });
});

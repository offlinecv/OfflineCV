// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression for #373 — a per-entry location dropped when a
 * "Company | Location Dates" header line has no separator between the location
 * and the date range:
 *
 *   Globex Financial | New York, NY August 2024 - Present
 *
 * `parseEntryBlocks` strips the trailing date range before disambiguation, so
 * the `|` cell reaching the field mapper is a clean "New York, NY" — but the
 * location sits BEFORE the (removed) dates, so `stripLocationSuffix`'s
 * end-anchored passes never claimed it and the location was dropped. A new step
 * recovers a bare location from the anchor line's non-company/non-title cell.
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

describe("location on 'Company | Location Dates' with no separator (#373)", () => {
  it("recovers the location from the pipe cell (alongside the #372 team mapping)", () => {
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

    expect(role.company).toBe("Globex Financial");
    expect(role.team).toBe("Business Credit Journey");
    expect(role.location).toBe("New York, NY");
  });

  it("recovers a single-word city too", () => {
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Staff Engineer, Platform", fontSize: 11 },
      { text: "Initech | Austin, TX July 2022 - August 2024", fontSize: 11 },
      { text: "• Owned the deploy pipeline.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].company).toBe("Initech");
    expect(roles[0].location).toBe("Austin, TX");
  });
});

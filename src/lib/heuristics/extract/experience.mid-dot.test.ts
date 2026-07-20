// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for `·`-delimited single-line experience headers (#217).
 *
 * Cover three shapes:
 *   1. Three-segment:  "Title · Company, City, ST · Team"
 *   2. Two-segment:    "Title · Company, City, ST"  (no team)
 *   3. First-entry:    founder-style role that arrives without a lookback header
 *                      line (previously landed in `company` with empty `title`)
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

describe("mid-dot (·) single-line experience headers (#217)", () => {
  it("three-segment header: extracts title, company (with location), and team", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Senior Staff Engineer · Acme Corp, Springfield, IL · Platform Team",
        fontSize: 11,
      },
      { text: "01/2019 - 02/2022", fontSize: 11 },
      { text: "• Reduced p99 latency 43% via a new service mesh.", fontSize: 11 },
      { text: "• Mentored 8 engineers across two time zones.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    // Title must contain the role keyword, not the entire joined line
    expect(roles[0].title.toLowerCase()).toContain("engineer");
    expect(roles[0].title).not.toContain("·");
    // Company must contain the org name (location trimming is #218)
    expect(roles[0].company).toContain("Acme Corp");
    // Team must be captured
    expect(roles[0].team).toBe("Platform Team");
  });

  it("two-segment header: extracts title and company (no team)", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Software Engineer · Beta Systems, Seattle, WA", fontSize: 11 },
      { text: "05/2016 - 12/2018", fontSize: 11 },
      {
        text: "• Built analytics pipeline processing 2M events/day.",
        fontSize: 11,
      },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].title.toLowerCase()).toContain("engineer");
    expect(roles[0].title).not.toContain("·");
    expect(roles[0].company).toContain("Beta Systems");
    expect(roles[0].team).toBeUndefined();
  });

  it("first-entry routing: title lands in title, not company, for a founder/CEO role", () => {
    // The first entry has no lookback header line above the date anchor — the
    // whole line must still split correctly (previously the whole line landed
    // in `company` with an empty `title`).
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Founder & CEO · Meridian Labs, Chicago, IL · Executive Team",
        fontSize: 11,
      },
      { text: "03/2022 - Present", fontSize: 11 },
      {
        text: "• Scaled platform from 0 to 50k MAU in 18 months.",
        fontSize: 11,
      },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    // Title must contain the role keyword (Founder or CEO), not be empty
    expect(roles[0].title).not.toBe("");
    expect(roles[0].title).not.toContain("·");
    expect(roles[0].title.toLowerCase()).toMatch(/founder|ceo/);
    // Company must be the org name, not the full header
    expect(roles[0].company).toContain("Meridian Labs");
    expect(roles[0].company).not.toContain("Founder");
  });

  it("multiple mid-dot entries parse all roles correctly", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Senior Engineer · Acme Corp, Springfield, IL · Platform Team",
        fontSize: 11,
      },
      { text: "01/2022 - Present", fontSize: 11 },
      { text: "• Led migration to cloud-native infrastructure.", fontSize: 11 },
      {
        text: "Software Engineer · Delta Tech, Austin, TX",
        fontSize: 11,
      },
      { text: "03/2019 - 12/2021", fontSize: 11 },
      { text: "• Shipped new API gateway reducing latency by 30%.", fontSize: 11 },
    ]);
    expect(roles.length).toBe(2);
    expect(roles[0].title.toLowerCase()).toContain("engineer");
    expect(roles[0].company).toContain("Acme Corp");
    expect(roles[0].team).toBe("Platform Team");

    expect(roles[1].title.toLowerCase()).toContain("engineer");
    expect(roles[1].company).toContain("Delta Tech");
    expect(roles[1].team).toBeUndefined();
  });

  it("does NOT split a line without mid-dot (no regression on comma-delimited or plain headers)", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Office Manager, Nod Publishing", fontSize: 11 },
      { text: "March 2023 - December 2024", fontSize: 11 },
      { text: "• Ran the front office for a 40-person team.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    // The comma split should still work (splitRoleComma path, not mid-dot path)
    expect(roles[0].title.toLowerCase()).toContain("office manager");
    expect(roles[0].company).toContain("Nod Publishing");
  });

  it("strips a trailing `·` left dangling on a two-line title header (#348)", () => {
    // WeasyPrint-Cairo shape: the title line ends in a bare trailing "·" with the
    // company on the NEXT line, so the " · " (whitespace-both-sides) split never
    // fires and the glyph would otherwise stay glued to the title.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Vice President ·", fontSize: 11 },
      { text: "Computer Science Society, Springfield State University", fontSize: 11 },
      { text: "01/2022 - 05/2024", fontSize: 11 },
      { text: "• Led the executive board and doubled active membership.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].title).toBe("Vice President");
    expect(roles[0].title).not.toContain("·");
    expect(roles[0].company).toContain("Computer Science Society");
  });

  it("neutral two-segment header keeps 'Title · Company' order (no swap, #436)", () => {
    // Neither segment carries a company-suffix or a title-keyword, so the
    // company/title tiebreaks can't decide. A single-line MIDDOT header follows
    // the "Title · Company" convention (the exporter's one-line shape, #217), so
    // the first segment must be the TITLE — otherwise the reconstructed header
    // re-parses title↔company swapped (the #436 round-trip failure).
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Composer · Northwind Ensemble", fontSize: 11 },
      { text: "2019 - 2021", fontSize: 11 },
      { text: "• Premiered twelve original chamber works.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].title).toBe("Composer");
    expect(roles[0].company).toBe("Northwind Ensemble");
  });

  it("a PIPE header keeps the company-first default (middot flip is middot-only)", () => {
    // The #436 title-first flip is gated to the MIDDOT delimiter. A "Company |
    // Location"-style pipe header must keep the company-first default so the flip
    // can't invert a different single-line convention.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Harborlight Chorale | Ensemble Member", fontSize: 11 },
      { text: "2020 - 2022", fontSize: 11 },
      { text: "• Sang in the touring ensemble.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].company).toBe("Harborlight Chorale");
    expect(roles[0].title).toBe("Ensemble Member");
  });
});

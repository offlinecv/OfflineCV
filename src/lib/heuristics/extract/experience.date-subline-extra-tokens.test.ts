// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for #614 — a middot experience header whose COMPANY sits in
 * the trailing `·` segment AND whose date sub-line carries EXTRA `·`-separated
 * tokens after the date range (e.g. `dates · level · headcount`) had the
 * `anchorHasReconstructedSignature` branch of `mapWithoutCompanyMatch`
 * misfire. That branch is designed for our own reconstructed export shape
 * (`Title \n Company · Location  Dates`), where the anchor line IS the
 * company sub-line and its middot marker is our export signature. The gate
 * (`anchorCarriesOrgSignal`) checked only for a `·` on the anchor line,
 * without distinguishing the export's own signature from a real-résumé date
 * sub-line whose post-strip residue happens to contain middots — so a date
 * line like `01/2024 – 12/2024 · L7 · 18 engineers, 2 TLMs` reduced to
 * `L7 · 18 engineers, 2 TLMs`, tripped the check, and the branch took the
 * first anchor-line token (`L7`) as the company — silently discarding the
 * real company on the title line above and dropping the location.
 *
 * The fix narrows the gate: the reconstructed-export shape emits a BARE title
 * above (no middot delim), so a middot-split title line above the anchor
 * already carries its own field mapping and the anchor line's middot is data
 * noise, not the export signature. The condition matrix from the issue:
 *
 *   a — trailing company + BARE date line               → OK (baseline)
 *   b — trailing company + date line with extra tokens  → FAIL pre-fix
 *   c — b, with location gaining a country suffix       → FAIL pre-fix
 *   d — MIDDLE-segment company + extra date tokens      → OK
 *   e — trailing company (bare, no location) + extras   → FAIL pre-fix
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

describe("date sub-line extra tokens don't hijack company (#614)", () => {
  it("row (a) baseline — bare date line, trailing-segment company splits cleanly", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Google, Hyderabad",
        fontSize: 11,
      },
      { text: "01/2024 – 12/2024", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Hyderabad");
    expect(role.team).toBe("Site Lead, Enterprise Platforms");
  });

  it("row (b) — extra `·`-tokens on the date line MUST NOT become the company", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Google, Hyderabad",
        fontSize: 11,
      },
      { text: "01/2024 – 12/2024 · L7 · 18 engineers, 2 TLMs", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Hyderabad");
    expect(role.team).toBe("Site Lead, Enterprise Platforms");
    // The date-line data token must not appear in any parsed field.
    expect(role.company).not.toBe("L7");
    expect(role.team).not.toContain("L7");
  });

  it("row (c) — same as (b) with a country-suffixed location", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Google, Hyderabad, India",
        fontSize: 11,
      },
      { text: "01/2024 – 12/2024 · L7 · 18 engineers, 2 TLMs", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Hyderabad, India");
    expect(role.team).toBe("Site Lead, Enterprise Platforms");
  });

  it("row (d) unchanged — MIDDLE-segment company with extra date tokens still parses", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Google, Hyderabad, India · Site Lead, Enterprise Platforms",
        fontSize: 11,
      },
      { text: "01/2024 – 12/2024 · L7 · 18 engineers, 2 TLMs", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.location).toBe("Hyderabad, India");
    expect(role.team).toBe("Site Lead, Enterprise Platforms");
  });

  it("row (e) — trailing-segment BARE company (no location) survives extra date tokens", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Google",
        fontSize: 11,
      },
      { text: "01/2024 – 12/2024 · L7 · 18 engineers, 2 TLMs", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Google");
    expect(role.team).toBe("Site Lead, Enterprise Platforms");
    expect(role.company).not.toBe("L7");
  });

  // Negative case (#639 review): the rotate that fixes rows b/c/e must NOT
  // fire when the trailing segment is entirely a bare LOCATION. That segment
  // fails `looksLikeTitle` too, but promoting it into `company` then shredding
  // it via `stripLocationSuffix` regressed `Engineer · Team Lead · New York, NY`
  // (bare-date, outside #614's condition matrix) to `company="New"` /
  // `location="York, NY"` on the first-pass fix. The `!isBareLocationString`
  // guard on the rotate keeps the whole-string bare-location shape flowing
  // through `rescueTeamLocation`'s rotate, which is how `main` handled it.
  it("trailing BARE-LOCATION segment is not promoted to company (bare date)", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Engineer · Team Lead · New York, NY", fontSize: 11 },
      { text: "01/2024 – 12/2024", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.location).toBe("New York, NY");
    expect(role.company).not.toBe("New");
    expect(role.company).not.toBe("New York, NY");
  });

  // Reviewer's #639 A/B (round 2): the `!aboveHasMiddotSegments` gate was too
  // broad — it also fired for a 2-segment `Title · Team` above line, which
  // carries NO company, so switching the anchor-signature branch OFF there
  // stranded the real company on the anchor line and swapped it with the team.
  // The narrowed gate keys on the 3-segment `Title · Team · Company` shape
  // (same predicate the middot exception's rotate uses), so a 2-segment above
  // line falls through to the anchor-signature branch as it did on `main`.
  it("2-segment `Title · Team` above with anchor-line company must NOT flip to `company=Team`", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Relationship Banking · Retail", fontSize: 11 },
      {
        text: "Northern Trust · Chicago  Jan 2019 – Mar 2021",
        fontSize: 11,
      },
      { text: "• Delivered a new client onboarding process.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.company).toBe("Northern Trust");
    expect(role.title).toBe("Relationship Banking");
    expect(role.team).toBe("Retail");
    expect(role.location).toBe("Chicago");
  });

  it("trailing BARE-LOCATION `City, Country` is not promoted to company either", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Site Lead, Enterprise Platforms · Hyderabad, India",
        fontSize: 11,
      },
      { text: "01/2024 – 12/2024", fontSize: 11 },
      { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];

    expect(role.location).toBe("Hyderabad, India");
    expect(role.company).not.toBe("Hyderabad");
    expect(role.company).not.toBe("Hyderabad, India");
  });
});

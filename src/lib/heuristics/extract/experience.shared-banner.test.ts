// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression for #382 — a single employer named ONCE as a banner above a
 * contiguous run of roles, each role's own header being a bare `Title, Team`:
 *
 *   Acme Corporation
 *     Staff Engineer, Platform Infrastructure   Aug 2024 - Present
 *     Senior Engineer, Payments Core            Jul 2022 - Aug 2024
 *     Engineer, Identity Services               Aug 2020 - Jul 2022
 *
 * The banner "Acme Corporation" heads all three roles but is written only once.
 * Only the first role's block captures it (as the dateless line above its dated
 * header); roles 2..N reduce to the `Title, Team` anchor line alone and resolve
 * to no real employer — the post-comma segment lands in `team` and `company`
 * collapses onto the title. `extractExperience` propagates the banner employer
 * down to each continuation role, so every role maps `company = <banner>`,
 * `title = <role>`, `team = <post-comma segment>`.
 *
 * Distinct from #372 (a `Title, Team` header over a *separate* delimited
 * `Company | Location Dates` anchor line): here the employer is a bare banner
 * with no date of its own, above the whole run.
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

describe("shared-employer banner over 'Title, Team' roles (#382)", () => {
  it("carries the banner employer down to every role in the run", () => {
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Acme Corporation", fontSize: 11 },
      {
        text: "Staff Engineer, Platform Infrastructure  Aug 2024 - Present",
        fontSize: 11,
      },
      { text: "• Led reliability work across the platform org.", fontSize: 11 },
      {
        text: "Senior Engineer, Payments Core  Jul 2022 - Aug 2024",
        fontSize: 11,
      },
      { text: "• Built the payment settlement rails.", fontSize: 11 },
      {
        text: "Engineer, Identity Services  Aug 2020 - Jul 2022",
        fontSize: 11,
      },
      { text: "• Shipped the single sign-on flow.", fontSize: 11 },
    ]);

    expect(roles).toHaveLength(3);

    expect(roles[0].company).toBe("Acme Corporation");
    expect(roles[0].title).toBe("Staff Engineer");
    expect(roles[0].team).toBe("Platform Infrastructure");

    expect(roles[1].company).toBe("Acme Corporation");
    expect(roles[1].title).toBe("Senior Engineer");
    expect(roles[1].team).toBe("Payments Core");

    expect(roles[2].company).toBe("Acme Corporation");
    expect(roles[2].title).toBe("Engineer");
    expect(roles[2].team).toBe("Identity Services");

    // The team must never be mislabeled as the company.
    for (const role of roles) {
      expect(role.company).toBe("Acme Corporation");
      expect(role.company).not.toBe(role.title);
      expect(role.company).not.toBe(role.team);
    }
  });

  it("lets a role with its own employer keep it and break the run", () => {
    // Roles 1-2 sit under the "Northwind" banner (suffix-less employer); role 3
    // states its OWN company-suffixed employer on its header line, so it keeps
    // that company and ENDS the run — a following bare role does not inherit
    // "Northwind".
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Northwind", fontSize: 11 },
      {
        text: "Staff Engineer, Platform Infrastructure  Aug 2024 - Present",
        fontSize: 11,
      },
      { text: "• Scaled the request tier.", fontSize: 11 },
      {
        text: "Senior Engineer, Payments Core  Jul 2022 - Aug 2024",
        fontSize: 11,
      },
      { text: "• Built the ledger service.", fontSize: 11 },
      {
        text: "Principal Engineer, Globex LLC  Jan 2020 - Jul 2022",
        fontSize: 11,
      },
      { text: "• Owned the data platform.", fontSize: 11 },
    ]);

    expect(roles).toHaveLength(3);
    expect(roles[0].company).toBe("Northwind");
    expect(roles[0].team).toBe("Platform Infrastructure");
    expect(roles[1].company).toBe("Northwind");
    expect(roles[1].team).toBe("Payments Core");
    // Role 3 named its own employer on the header line — it is NOT inherited.
    expect(roles[2].company).toBe("Globex LLC");
    expect(roles[2].title).toBe("Principal Engineer");
  });

  it("does not touch a single 'Title, Company' role (no banner, no regression)", () => {
    // No banner above, plain date line below: the post-comma segment is the
    // employer and must stay the company (the #372 no-regression contract).
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Office manager, Nod Publishing", fontSize: 11 },
      { text: "March 2023 - December 2024", fontSize: 11 },
      { text: "• Ran the front office for a 40-person team.", fontSize: 11 },
    ]);

    expect(roles).toHaveLength(1);
    expect(roles[0].title.toLowerCase()).toContain("office manager");
    expect(roles[0].company).toBe("Nod Publishing");
  });
});

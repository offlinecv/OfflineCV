// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for the Pass B corporate-tail deferral (#641).
 *
 * Pass B of `stripLocationSuffix` is a SINGLE-TOKEN space-delimited city rule:
 * it takes the last whitespace-delimited word before the comma and calls it the
 * city. When a company's own last word precedes a `, ST` tail, the company was
 * cleaved and a company word promoted to a location:
 *
 *   "Palo Alto Networks, CA"  → company "Palo Alto"   + location "Networks, CA"
 *   "Santa Clara Systems, CA" → company "Santa Clara" + location "Systems, CA"
 *
 * Both halves are wrong: `Networks, CA` is not a location and `Palo Alto` is not
 * the employer. The fix has two halves, and each is pinned separately below:
 *   (a) a `COMPANY_TAIL_TOKENS_RE` deferral so the corporate noun is never taken
 *       as the city, and
 *   (b) a state-code-only peel in that deferral branch, mirroring Pass E's
 *       trailing-country-only strip, so the company keeps every word AND the
 *       location still surfaces.
 *
 * The closed city vocabulary cannot decide this on its own — `Palo Alto` is in
 * `MULTIWORD_US_CITY_ALT` in BOTH "Palo Alto Networks, CA" (company) and
 * "Acme Palo Alto, CA" (company + city); only POSITION relative to the comma
 * differentiates them. So the "already works" rows are pinned here too: the
 * deferral is scoped to Pass B and must not trade away the Pass B-multi split
 * #636 delivered.
 *
 * Synthetic personas only, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { groupIntoLines, splitIntoSections, findSection } from "../sections.ts";
import { extractExperience } from "../extract-fields.ts";
import { mkItems } from "../__test-utils__/mkItem.ts";

function roleFromHeader(header: string) {
  const sections = splitIntoSections(
    groupIntoLines(
      mkItems([
        { text: "EXPERIENCE", fontSize: 13 },
        { text: header, fontSize: 11 },
        { text: "04/2021 – 12/2023", fontSize: 11 },
        {
          text: "• Ran a cross-team migration to a shared platform.",
          fontSize: 11,
        },
      ]),
    ),
  );
  const experience = findSection(sections, "experience");
  expect(experience).toBeDefined();
  const roles = extractExperience(experience).value;
  expect(roles.length).toBeGreaterThanOrEqual(1);
  return roles[0];
}

describe("company tail before a state suffix (#641)", () => {
  // Half (a) + (b) together: the exact rows the issue reproduces. Reverting the
  // deferral guard restores `company: "Palo Alto"` / `location: "Networks, CA"`;
  // reverting only the state-code peel leaves `company: "Palo Alto Networks, CA"`
  // with no location. Both assertions are therefore load-bearing.
  it.each([
    ["Palo Alto Networks", "CA"],
    ["Santa Clara Systems", "CA"],
    ["Redwood City Ventures", "CA"],
    // A company whose tail noun is not preceded by a vocabulary city — the same
    // defect without any MULTIWORD_US_CITY_ALT involvement.
    ["Acme Networks", "CA"],
  ])("`%s, %s` keeps the company whole", (company, state) => {
    const role = roleFromHeader(`Engineer · ${company}, ${state}`);
    expect(role.company).toBe(company);
    expect(role.location).toBe(state);
    // No company word may end up in the location.
    for (const word of company.split(" ")) {
      expect(role.location).not.toContain(word);
    }
  });

  // The period-bearing forms (#641 review). `Corp.` / `Inc.` / `Ltd.` /
  // `Labs.` are the CANONICAL written spelling of the commonest corporate
  // tails, and Pass B's capture group `[A-Z][A-Za-z.\-]+` includes the period —
  // so a `$`-anchored vocabulary with no optional dot never fired for any of
  // them and the deferral silently skipped exactly the shape it exists for.
  // `Co` is the same defect one token shorter: absent from the vocabulary
  // entirely, though `LEGAL_SUFFIX_RE` has carried `co\.?` all along.
  it.each([
    ["Acme Corp.", "CA"],
    ["Acme Inc.", "NY"],
    ["Acme Ltd.", "TX"],
    ["Acme Labs.", "CA"],
    ["Acme Co", "CA"],
    ["Acme Co.", "CA"],
  ])("`%s, %s` keeps the abbreviated corporate tail", (company, state) => {
    const role = roleFromHeader(`Engineer · ${company}, ${state}`);
    expect(role.company).toBe(company);
    expect(role.location).toBe(state);
  });

  // The improvement #636 delivered as a side effect of the shared city
  // vocabulary. The deferral is scoped to Pass B precisely so these keep
  // splitting through Pass B-multi; if the guard ever leaks into Pass B-multi
  // these fail rather than silently regressing.
  it.each([
    ["Palo Alto", "CA"],
    ["Santa Clara", "CA"],
    ["Redwood City", "CA"],
  ])("`Acme %s, %s` still splits company from city", (city, state) => {
    const role = roleFromHeader(`Engineer · Acme ${city}, ${state}`);
    expect(role.company).toBe("Acme");
    expect(role.location).toBe(`${city}, ${state}`);
  });

  // Pass B itself must still fire for a single-token city that is NOT a
  // corporate tail noun — the deferral is a narrowing, and a narrowing that
  // swallowed the whole pass would pass every test above while breaking these.
  it.each([
    ["Northwind Labs", "Bellevue", "WA"],
    ["Acme Corp", "Austin", "TX"],
  ])("`%s %s, %s` still strips the city", (company, city, state) => {
    const role = roleFromHeader(`Engineer · ${company} ${city}, ${state}`);
    expect(role.company).toBe(company);
    expect(role.location).toBe(`${city}, ${state}`);
  });

  it("comma-delimited Pass A is untouched", () => {
    const role = roleFromHeader("Engineer · Acme, Springfield, IL");
    expect(role.company).toBe("Acme");
    expect(role.location).toBe("Springfield, IL");
  });

  it("Pass B-multi is untouched on a corporate-tail company", () => {
    // "Analytics" IS a corporate tail token, but it is not adjacent to the
    // comma — the vocabulary city is — so Pass B-multi wins and the deferral
    // never runs.
    const role = roleFromHeader("Engineer · Acme Analytics New York, NY");
    expect(role.company).toBe("Acme Analytics");
    expect(role.location).toBe("New York, NY");
  });

  it("the intl sibling shape is unchanged", () => {
    // Pass D defers on "Group" and Pass E peels the bare country — the exact
    // behaviour the US branch now mirrors.
    const role = roleFromHeader("Engineer · Acme Group, India");
    expect(role.company).toBe("Acme Group");
    expect(role.location).toBe("India");
  });

  // `COMPANY_TAIL_TOKENS_RE` is SHARED with Pass D, so the optional-period
  // widening reaches the international path too. Pinned here so a future
  // narrowing of the vocabulary can't quietly regress Pass D while the US rows
  // above stay green.
  it.each([
    ["Acme Group", "India"],
    ["Acme Group.", "India"],
    ["Acme Ltd.", "India"],
  ])("Pass D still defers on `%s, %s`", (company, country) => {
    const role = roleFromHeader(`Engineer · ${company}, ${country}`);
    expect(role.company).toBe(company);
    expect(role.location).toBe(country);
  });
});

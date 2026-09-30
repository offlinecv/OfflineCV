// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for the org / sub-organisation routing contract (#836).
 *
 * When an employer line names an organisation and a sub-organisation, the
 * OUTER org routes to `company` and the sub-org routes to `team`, regardless
 * of which half is drawn first. Pins both orders measured on the corpus:
 *   - `Multicultural Engineering Program – State Polytechnic University`
 *     (google-docs/google-docs-skia-proxy-role-first-experience.pdf) — the
 *     sub-org is drawn FIRST, joined by an en dash, on its own line below a
 *     bare date anchor.
 *   - `Ohio Valley State University — IT Service Desk — Columbus, Ohio`
 *     (unknown/single-column-title-below-anchor.pdf) — the org is drawn
 *     FIRST, on the date-anchor row, with the title on the line below it.
 *
 * See `disambiguateCompanyTitle` in `experience-disambiguate.ts` for the
 * org-hint mechanism (`looksLikeCompany`) this contract rests on.
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

describe("org / sub-org routing contract (#836)", () => {
  it("sub-org first: 'Program – University' routes the university to company, the program to team", () => {
    // Mirrors google-docs-skia-proxy-role-first-experience.pdf role 2: a
    // role-first stack — title, then a bare date-only anchor line, then the
    // en-dash-joined org line below it.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Peer Tutor (15 to 20 hours per week)", fontSize: 11 },
      { text: "August 2022 – Present", fontSize: 11 },
      { text: "Multicultural Engineering Program – State Polytechnic University", fontSize: 11 },
    ]);
    expect(roles).toHaveLength(1);
    expect(roles[0].company).toBe("State Polytechnic University");
    expect(roles[0].team).toBe("Multicultural Engineering Program");
    expect(roles[0].title).toBe("Peer Tutor (15 to 20 hours per week)");
  });

  it("org first: 'University — Service Desk — Location' routes the university to company, the desk to team", () => {
    // Mirrors single-column-title-below-anchor.pdf role 2: the anchor row
    // carries "University — Sub-org — Location  Dates" and the title sits on
    // the line below it (#342 shape). The trailing "— Columbus, Ohio" cell is
    // a pre-existing, separately-scoped location-extraction gap (a spelled-out
    // US state name isn't in the bare-location vocabulary the way a two-letter
    // code is) — not part of the org/sub-org contract this test pins, so
    // `location` is deliberately left unasserted here.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Ohio Valley State University — IT Service Desk — Columbus, Ohio   Jan 2023 - May 2024", fontSize: 11 },
      { text: "Data Analyst", fontSize: 11 },
      { text: "• Analyzed IT support ticket data using SQL.", fontSize: 11 },
    ]);
    expect(roles).toHaveLength(1);
    expect(roles[0].company).toBe("Ohio Valley State University");
    expect(roles[0].team).toBe("IT Service Desk");
    expect(roles[0].title).toBe("Data Analyst");
  });
});

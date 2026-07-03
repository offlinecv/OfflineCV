// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Regression tests for the anchor-position company/title tiebreak in
 * `disambiguateCompanyTitle` (#298 review).
 *
 * The tiebreak treats the date-anchor line as the COMPANY and the line above it
 * as the TITLE — but ONLY when the anchor line carries the reconstructed-export
 * signature: an edge/whitespace-bounded " · " middot marker (`anchorCarriesOrgSignal`).
 * Our own "Download PDF" emit always appends it to the company sub-line
 * ("Company · Location  Dates" or "Company · Dates"). Location- and title-keyword
 * signals were removed (Phase 4b): on a genuinely ambiguous two-line header the
 * anchor line's shape alone can't disambiguate company from title, so every
 * location/comma/keyword heuristic created a symmetric company↔title inversion on
 * generic real résumés. A genuine "Company (top) / Title + Dates (bottom)" résumé
 * whose anchor has no middot must NOT invert; it falls through to the pre-#298
 * default (company = first line) — exactly as it behaved before #298.
 *
 * Exercised through `extractExperience` (the real caller) rather than the
 * un-exported helper. Synthetic personas only, per the fixtures PII policy.
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

describe("anchor-position tiebreak gate (#298)", () => {
  it("does NOT invert a genuine 'Company top / Title + Dates bottom' résumé with no lexical tell", () => {
    // Neither line carries a company suffix, a title keyword, a location, or a
    // " · " separator — a fully neutral two-line stack. The anchor line (the
    // TITLE, carrying the dates) must stay the title; the top line stays the
    // company. (Old #298 behavior inverted this: company="Relationship Banking".)
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Northern Trust", fontSize: 11 },
      { text: "Relationship Banking   Jan 2019 - Mar 2021", fontSize: 11 },
      { text: "• Managed a portfolio of client relationships.", fontSize: 11 },
    ]);
    expect(roles.length).toBe(1);
    expect(roles[0].company).toBe("Northern Trust");
    expect(roles[0].title).toBe("Relationship Banking");
  });

  it("still fires the tiebreak on the reconstructed 'Title / Company · Location Dates' shape", () => {
    // Our own "Download PDF" export shape: a bare title header over a
    // "Company · Location  Dates" anchor. The " · " signals the anchor is the
    // company, so the tiebreak assigns company=Company, title=Title (round-trip).
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Relationship Banking", fontSize: 11 },
      { text: "Northern Trust · Chicago, IL   Jan 2019 - Mar 2021", fontSize: 11 },
      { text: "• Managed a portfolio of client relationships.", fontSize: 11 },
    ]);
    expect(roles.length).toBe(1);
    expect(roles[0].title).toBe("Relationship Banking");
    expect(roles[0].company).toBe("Northern Trust");
    expect(roles[0].location).toBe("Chicago, IL");
  });

  it("does NOT invert when the anchor TITLE ends in an embedded (comma-attached) location [case a]", () => {
    // A genuine two-line entry whose title carries a comma-attached location tail
    // ("Field Sales, Austin, TX"). The anchor line has no middot, so the tiebreak
    // does not fire and the top line stays the company. Under the earlier
    // location-based gates this "Austin, TX" tail was read as an org signal and
    // inverted the roles to company="Field Sales"; the middot-only gate never
    // looks at the location, so it cannot invert here (Phase 4b).
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Salesforce", fontSize: 11 },
      { text: "Field Sales, Austin, TX   Jan 2020 - Mar 2022", fontSize: 11 },
      { text: "• Closed enterprise deals.", fontSize: 11 },
    ]);
    expect(roles.length).toBe(1);
    expect(roles[0].company).toBe("Salesforce");
    expect(roles[0].title).toBe("Field Sales");
    expect(roles[0].location).toBe("Austin, TX");
  });

  it("leaves the pre-existing 'Company, City, ST anchor under a non-keyword title' ambiguity unchanged [case b]", () => {
    // A genuine two-line entry where the REAL company ("Acme Widgets, Austin, TX")
    // is on the date-anchor line and a non-keyword TITLE ("Customer Success") is on
    // top. With no middot, no company suffix, and no title keyword, nothing in the
    // content distinguishes which line is the company — so the pre-#298 default
    // (company = first line) applies and mis-labels "Customer Success" as the
    // company. This is a PRE-EXISTING content ambiguity: main (no anchor tiebreak
    // at all) produces the identical mapping. The middot-only gate neither fixes
    // nor worsens it — asserted here so no future gate silently re-inverts it in a
    // direction that diverges from main. (#298 only ever aimed to round-trip our
    // OWN reconstructed export, which always carries the middot.)
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Customer Success", fontSize: 11 },
      { text: "Acme Widgets, Austin, TX   Jan 2020 - Mar 2022", fontSize: 11 },
      { text: "• Ran the customer success org.", fontSize: 11 },
    ]);
    expect(roles.length).toBe(1);
    // Pre-existing default (== main): company = first line. Documented, not desired.
    expect(roles[0].company).toBe("Customer Success");
    expect(roles[0].title).toBe("Acme Widgets");
    expect(roles[0].location).toBe("Austin, TX");
  });

  it("fires on the reconstructed location-less shape via the ' ·' org-signature marker", () => {
    // A location-less reconstructed role emits "Company · Dates" (the " · "
    // org-signature marker before the date, ats-resume-model.ts). The anchor line
    // is then recognizably the company; the marker is stripped back off so the
    // company field is clean.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Relationship Banking", fontSize: 11 },
      { text: "Northern Trust · Jan 2019 - Mar 2021", fontSize: 11 },
      { text: "• Managed a portfolio of client relationships.", fontSize: 11 },
    ]);
    expect(roles.length).toBe(1);
    expect(roles[0].title).toBe("Relationship Banking");
    expect(roles[0].company).toBe("Northern Trust");
  });
});

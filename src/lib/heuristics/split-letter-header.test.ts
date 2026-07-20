// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression for #56: a letter-spaced "E XPERIENCE" header must still open an
 * experience section so `extractExperience` populates `parsed.experience`
 * (which in turn re-enables per-bullet role grouping in the UI).
 *
 * Synthetic persona only — no PDF binary, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { groupIntoLines, splitIntoSections, findSection } from "./sections.ts";
import { extractExperience } from "./extract-fields.ts";
import { mkItems } from "./__test-utils__/mkItem.ts";

function build(specs: Array<{ text: string; fontSize?: number }>) {
  return splitIntoSections(groupIntoLines(mkItems(specs)));
}

describe("split-letter section header → experience extraction (#56)", () => {
  it("opens an experience section from 'E XPERIENCE' and extracts a role", () => {
    const sections = build([
      { text: "Alex Rivera", fontSize: 18 },
      { text: "alex@example.com | 555-0100 | Santa Clara, CA", fontSize: 10 },
      { text: "" },
      { text: "E XPERIENCE", fontSize: 13 },
      { text: "Senior Engineer, Acme Corp  01/2020 - 03/2023", fontSize: 11 },
      { text: "• Led migration to a new service mesh, cutting p99 latency 40%.", fontSize: 11 },
      { text: "• Mentored 6 engineers across two sites.", fontSize: 11 },
    ]);

    const experience = findSection(sections, "experience");
    expect(experience).toBeDefined();

    const { value } = extractExperience(experience);
    expect(value.length).toBeGreaterThanOrEqual(1);
    expect(value[0].company).toContain("Acme Corp");
    expect(value[0].description).toContain("service mesh");
  });

  it("merges a page-2 'E XPERIENCE' continuation header into one experience section", () => {
    // Multi-page two-column résumés repeat the section header at the top of
    // page 2 ("E XPERIENCE"), opening a SECOND experience section. findSection
    // must merge both so page-2 roles are extracted — otherwise their bullets
    // strand in the unmatched "Other" group. Regression for the lost-page-2-
    // employment bug.
    const sections = build([
      { text: "Alex Rivera", fontSize: 18 },
      { text: "E XPERIENCE", fontSize: 13 },
      { text: "Senior Engineer, Acme Corp  01/2020 - 03/2023", fontSize: 11 },
      { text: "• Led migration to a new service mesh, cutting p99 latency 40%.", fontSize: 11 },
      { text: "E XPERIENCE", fontSize: 13 },
      { text: "Staff Engineer, Globex Inc  06/2016 - 12/2019", fontSize: 11 },
      { text: "• Built the billing pipeline handling 2M daily events.", fontSize: 11 },
    ]);

    // Two experience sections were opened, one per header.
    expect(sections.filter((s) => s.name === "experience")).toHaveLength(2);

    // findSection merges them; both roles survive extraction.
    const experience = findSection(sections, "experience");
    expect(experience).toBeDefined();
    const { value } = extractExperience(experience);
    const companies = value.map((e) => e.company ?? "");
    expect(companies.some((c) => c.includes("Acme Corp"))).toBe(true);
    expect(companies.some((c) => c.includes("Globex Inc"))).toBe(true);
  });

  it("regression guard: a clean 'EXPERIENCE' header still works", () => {
    const sections = build([
      { text: "Alex Rivera", fontSize: 18 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Senior Engineer, Acme Corp  01/2020 - 03/2023", fontSize: 11 },
      { text: "• Led migration to a new service mesh, cutting p99 latency 40%.", fontSize: 11 },
    ]);
    expect(findSection(sections, "experience")).toBeDefined();
  });
});

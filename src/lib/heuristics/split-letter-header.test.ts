// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

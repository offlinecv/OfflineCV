// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression for #554 — a "Company, Location |Title" header whose pipe is tight
 * against the title (space BEFORE the pipe, none after) dropped the title:
 *
 *   Globex AI Labs LLC ,CA, USA |Intern    Jul 2025 - Present
 *
 * The delimiter split in `splitHeaderSegments` required whitespace on BOTH
 * sides of the pipe (`\s+\|\s+`), so `USA |Intern` never cleaved — the whole
 * run collapsed into `company` and `title` came back empty. The split now
 * accepts whitespace on at least one side, while a zero-width `A|B` (no
 * surrounding whitespace) still stays unsplit.
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

describe("tight-right pipe 'Company, Location |Title' (#554)", () => {
  it("cleaves the title off a pipe with no trailing space", () => {
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      {
        text: "Globex AI Labs LLC, USA |Intern Jul 2025 - Present",
        fontSize: 11,
      },
      { text: "• Built a secure transcription pipeline.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const role = roles[0];
    // #554 is the title/company split: the tail after the tight pipe must land
    // in `title`, and `company` must no longer carry the "|Intern" run.
    expect(role.title).toBe("Intern");
    expect(role.company).toContain("Globex AI Labs LLC");
    expect(role.company).not.toContain("|");
    expect(role.company).not.toContain("Intern");
  });

  it("does NOT split a zero-width 'A|B' with no surrounding whitespace", () => {
    const roles = roleFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Acme|Beta Systems Jan 2020 - Dec 2021", fontSize: 11 },
      { text: "• Shipped the platform.", fontSize: 11 },
    ]);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles[0].company).toContain("Acme|Beta Systems");
    expect(roles[0].title ?? "").toBe("");
  });
});

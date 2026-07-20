// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { localizeSkills, looseSkillsReason } from "./skills.ts";
import { mkCascade } from "./__test-utils__.ts";

describe("localizeSkills", () => {
  it("emits no defect when skills parsed", () => {
    const cascade = mkCascade({
      fields: { skills: ["Python", "TypeScript"] },
      sections: { skills: ["Python, TypeScript"] },
    });
    const out = localizeSkills(cascade);
    expect(out.defects).toEqual([]);
    expect(out.verdict).toMatch(/^ok/);
  });

  it("localizes skills-extraction-miss when the region routed but nothing parsed", () => {
    const cascade = mkCascade({
      fields: { skills: [] },
      sections: { skills: ["Python, TypeScript"] },
    });
    const out = localizeSkills(cascade);
    expect(out.defects).toEqual(["skills-extraction-miss"]);
    expect(out.verdict).toMatch(/^EXTRACTION-MISS/);
  });

  it("localizes skills-header-unrecognized when an out-of-alias header is rejected", () => {
    const cascade = mkCascade({
      fields: { skills: [] },
      sections: {},
      markdown: "# Skills Summary\nPython, TypeScript\n# Experience\n",
    });
    const out = localizeSkills(cascade);
    expect(out.defects).toEqual(["skills-header-unrecognized"]);
    expect(out.derived.skillsHeaderCandidateRejected).toBe(true);
    expect(out.verdict).toMatch(/^HEADER-UNRECOGNIZED/);
  });

  it("localizes skills-no-section when nothing skills-like exists anywhere", () => {
    const cascade = mkCascade({
      fields: { skills: [] },
      sections: {},
      markdown: "# Experience\nSome role\n",
    });
    const out = localizeSkills(cascade);
    expect(out.defects).toEqual(["skills-no-section"]);
    expect(out.derived.skillsHeaderCandidateRejected).toBe(false);
    expect(out.verdict).toMatch(/^NO-SKILLS-SECTION/);
  });

  it("withholds skills-no-section when there is no markdown to read (scanned/sparse)", () => {
    // The header oracle reads `cascade.markdown` and nothing else. With no
    // markdown it cannot tell a rejected header from a résumé with no skills
    // section — so it reports NEITHER class rather than guessing the one 9
    // fixtures "cover". The verdict text is unchanged (the harness contract);
    // only the CLASS is withheld.
    const cascade = mkCascade({ fields: { skills: [] }, sections: {} });
    const out = localizeSkills(cascade);
    expect(out.headerOracleUnavailable).toBe(true);
    expect(out.derived.headerOracleUnavailable).toBe(true);
    expect(out.defects).toEqual([]);
    expect(out.verdict).toMatch(/^NO-SKILLS-SECTION/);
  });

  it("looseSkillsReason strips a leading decorative glyph", () => {
    expect(looseSkillsReason("★Skills")).toMatch(/leading-glyph prefix/);
    expect(looseSkillsReason("Random Prose")).toBeNull();
  });
});

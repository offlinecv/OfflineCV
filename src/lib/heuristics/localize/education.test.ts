// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { localizeEducation, looseEducationReason, countDegrees } from "./education.ts";
import { mkCascade } from "./__test-utils__.ts";

describe("localizeEducation", () => {
  it("emits no defect when entries are present and complete", () => {
    const cascade = mkCascade({
      fields: {
        education: [
          { institution: "State University", degree: "Bachelor of Science" },
        ],
      },
      sections: { education: ["Bachelor of Science, State University"] },
    });
    const out = localizeEducation(cascade);
    expect(out.defects).toEqual([]);
    expect(out.verdict).toMatch(/^ok/);
  });

  it("localizes education-extraction-miss when the region routed but nothing parsed", () => {
    const cascade = mkCascade({
      fields: { education: [] },
      sections: { education: ["Bachelor of Science, State University"] },
    });
    const out = localizeEducation(cascade);
    expect(out.defects).toEqual(["education-extraction-miss"]);
  });

  it("localizes education-header-unrecognized for an anchor-bearing header the strict router rejects", () => {
    const cascade = mkCascade({
      fields: { education: [] },
      sections: {},
      markdown:
        "# education overview\nBachelor of Science, State University\n# Skills\n",
    });
    const out = localizeEducation(cascade);
    expect(out.defects).toEqual(["education-header-unrecognized"]);
    expect(out.derived.educationHeaderCandidateRejected).toBe(true);
  });

  it("localizes education-no-section when nothing education-like exists", () => {
    const cascade = mkCascade({
      fields: { education: [] },
      sections: {},
      markdown: "# Experience\nSome role\n",
    });
    const out = localizeEducation(cascade);
    expect(out.defects).toEqual(["education-no-section"]);
  });

  it("withholds education-no-section when there is no markdown to read (scanned/sparse)", () => {
    const cascade = mkCascade({ fields: { education: [] }, sections: {} });
    const out = localizeEducation(cascade);
    expect(out.headerOracleUnavailable).toBe(true);
    expect(out.defects).toEqual([]);
    expect(out.verdict).toMatch(/^NO-EDUCATION-SECTION/);
  });

  it("localizes education-under-chunked when DEGREE_RE tokens exceed entries", () => {
    const cascade = mkCascade({
      fields: {
        education: [{ institution: "State University", degree: "BS" }],
      },
      sections: {
        education: [
          "Bachelor of Science, State University",
          "Master of Science, Other University",
        ],
      },
    });
    const out = localizeEducation(cascade);
    expect(out.defects).toEqual(["education-under-chunked"]);
    expect(out.derived.educationEntriesFewerThanDegreeTokens).toBe(true);
  });

  it("countDegrees counts DEGREE_RE tokens without mutating shared state", () => {
    expect(
      countDegrees("Bachelor of Science, State University\nMaster of Science, Other University"),
    ).toBe(2);
  });

  it("looseEducationReason strips a leading decorative glyph", () => {
    expect(looseEducationReason("★Education")).toMatch(/leading-glyph prefix/);
    expect(looseEducationReason("Random Prose")).toBeNull();
  });
});

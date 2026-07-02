// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for the markdown/DOCX section path (`sectionizeMarkdown`).
 *
 * Focus: the #258 Layer B parity port. The PDF splitter (`classifyLine`) and
 * this markdown path share the same invariant — an L2 head-noun-anchor line
 * that re-matches the CURRENTLY open section is an institution entry under its
 * own header, not a new boundary, and must be retained as content. This file
 * pins that behavior on the markdown path so the two never drift.
 */

import { sectionizeMarkdown } from "./markdown-lines.ts";

describe("sectionizeMarkdown — institution name ending in a section anchor (#258 Layer B)", () => {
  it("retains an all-caps institution line under an open education section instead of eating it as a 2nd header", () => {
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
      "",
      "**EDUCATION**",
      "",
      "ACME PROFESSIONAL EDUCATION",
      "",
      "M.S. Data Science  2018 - 2020",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    // The institution line is retained as content inside an education section,
    // not consumed as a boundary label (which would drop the institution name).
    const inst = sections.find((s) =>
      s.lines.some((l) => l.text.includes("ACME PROFESSIONAL EDUCATION")),
    );
    expect(inst).toBeDefined();
    expect(inst!.name).toBe("education");

    // Exactly one education section — the institution line did NOT open a second.
    expect(sections.filter((s) => s.name === "education").length).toBe(1);
  });

  it("still opens a genuine L2 header for a DIFFERENT section than the one currently open", () => {
    // Suppression is gated on the CURRENTLY-open section, not "ever opened": a
    // real "Relevant Experience" (L2) header after an EDUCATION block must open
    // its own experience section, not bleed into education.
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
      "",
      "**EDUCATION**",
      "",
      "B.S. Computer Science, MIT  2019",
      "",
      "Relevant Experience",
      "",
      "Mentor, Local Shelter  2022 - Present",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    const mentor = sections.find((s) =>
      s.lines.some((l) => l.text.includes("Mentor, Local Shelter")),
    );
    expect(mentor).toBeDefined();
    expect(mentor!.name).toBe("experience");

    const edu = sections.find((s) =>
      s.lines.some((l) => l.text.includes("B.S. Computer Science")),
    );
    expect(edu!.name).toBe("education");
    expect(edu!.lines.some((l) => l.text.includes("Mentor"))).toBe(false);
  });
});

describe("sectionizeMarkdown — rawHeading capture (#285)", () => {
  it("captures the verbatim heading text, stripped of markdown decoration, for a synonym", () => {
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
      "",
      "**Work History**",
      "",
      "Engineer, Globex  2019 - 2021",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    const experience = sections.find((s) => s.name === "experience");
    expect(experience?.rawHeading).toBe("Work History");
  });

  it("leaves rawHeading undefined for the profile section", () => {
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    const profile = sections.find((s) => s.name === "profile");
    expect(profile?.rawHeading).toBeUndefined();
  });
});

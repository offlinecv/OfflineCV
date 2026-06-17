// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { matchSectionHeader } from "./regex.ts";

describe("matchSectionHeader — split-letter headers (#56)", () => {
  it("matches a clean header unchanged", () => {
    expect(matchSectionHeader("EXPERIENCE")).toBe("experience");
    expect(matchSectionHeader("Education")).toBe("education");
  });

  it("recovers a split lead letter on allowlisted sections", () => {
    // Designed templates letter-space the first glyph: pdfjs reads
    // "EXPERIENCE" as "E XPERIENCE".
    expect(matchSectionHeader("E XPERIENCE")).toBe("experience");
    expect(matchSectionHeader("e xperience")).toBe("experience");
    expect(matchSectionHeader("S UMMARY")).toBe("summary");
    expect(matchSectionHeader("E DUCATION")).toBe("education");
  });

  it("does NOT recover split-letter skills (sidebar S KILLS would strand roles)", () => {
    expect(matchSectionHeader("S KILLS")).toBeNull();
  });

  it("ignores a split-letter header that doesn't reduce to a keyword", () => {
    // "EXPERIENCE FOCUS AREAS" sidebar label — rejoins to multi-word text,
    // which is not an exact keyword.
    expect(matchSectionHeader("E XPERIENCE F OCUS AREAS")).toBeNull();
  });

  it("does not mint a section from prose with an incidental split word", () => {
    expect(matchSectionHeader("i have experience")).toBeNull();
    expect(matchSectionHeader("a summary of my work")).toBeNull();
  });
});

describe("matchSectionHeader — head-noun anchor fallback (#108 / #111)", () => {
  it("classifies qualified experience headers by their head noun", () => {
    // #108 reporter's two headings.
    expect(matchSectionHeader("Relevant Experience")).toBe("experience");
    expect(matchSectionHeader("Customer Service Experience")).toBe("experience");
    // Other open-ended qualifiers over the same closed head noun.
    expect(matchSectionHeader("Editorial Experience")).toBe("experience");
    expect(matchSectionHeader("Leadership Experience")).toBe("experience");
  });

  it("classifies qualified headers for other fallback-enabled sections", () => {
    expect(matchSectionHeader("Technical Certifications")).toBe("certifications");
    expect(matchSectionHeader("Professional Awards")).toBe("achievements");
  });

  it("does not double-classify exact aliases (first loop still wins)", () => {
    // Exact aliases still resolve via the keyword path, not the fallback.
    expect(matchSectionHeader("Experience")).toBe("experience");
    expect(matchSectionHeader("Work Experience")).toBe("experience");
  });

  it("rejects prose: long-form sentence with an incidental head noun", () => {
    // FP #1: over the 40-char length gate AND head noun is not the last token.
    expect(
      matchSectionHeader("5 years of relevant experience leading teams"),
    ).toBeNull();
  });

  it("rejects prose: head noun present but not the last token", () => {
    // FP #2: "Experience" appears but does not END the line — head-noun-LAST,
    // not substring contains. Title-cased so only the last-token guard rejects.
    expect(matchSectionHeader("Experience In Marketing")).toBeNull();
  });

  it("rejects lowercase prose ending in a head noun", () => {
    // FP #3: a lowercase sentence fragment that ends in an anchor is prose, not
    // a heading — the header-casing guard separates "Relevant Experience" from
    // "i have experience" (the #56 regression this would otherwise reopen).
    expect(matchSectionHeader("i have experience")).toBeNull();
    expect(matchSectionHeader("looking for new employment")).toBeNull();
  });

  it("rejects numeric-qualifier prose ending in a head noun", () => {
    // FP #3b: a digit/symbol lead char is neither lower- nor uppercase, so the
    // casing guard must require uppercase (not merely "not lowercase"), else
    // "5 Years Experience" opens an experience boundary mid-summary.
    expect(matchSectionHeader("5 Years Experience")).toBeNull();
    expect(matchSectionHeader("10+ Years Experience")).toBeNull();
    expect(matchSectionHeader("3 Years Experience")).toBeNull();
  });

  it("rejects a header-shaped line ending in terminal punctuation", () => {
    // FP #4: terminal sentence punctuation marks prose, not a heading.
    expect(matchSectionHeader("Gained Relevant Experience.")).toBeNull();
  });

  it("rejects a Title-Case phrase over the 4-word count guard", () => {
    // FP #5: last token is a valid anchor and the phrase is header-cased, but
    // too many words (5) to be a section header.
    expect(matchSectionHeader("My Many Years Of Experience")).toBeNull();
  });

  it("rejects a bullet line whose last token is an anchor", () => {
    // FP #5: a bullet glyph means content, not a heading.
    expect(matchSectionHeader("• Relevant Experience")).toBeNull();
    expect(matchSectionHeader("- Customer Service Experience")).toBeNull();
  });

  it("keeps skills OFF the raw-line anchor path (anchorFallback false)", () => {
    // FP #6: a flattened two-column "Core Skills" / "Technical Skills" sidebar
    // label must NOT open a section via the anchor fallback — it would strand
    // every following experience role. (Bare "Skills" still matches via the
    // exact-alias keyword path; "Core Skills" is the qualified anchor case.)
    expect(matchSectionHeader("Core Skills")).toBeNull();
    expect(matchSectionHeader("Cloud Technologies")).toBeNull();
  });

  it("keeps the 'other' family OFF the anchor path", () => {
    // "other" has no anchors and anchorFallback false; qualified forms over its
    // aliases stay unclassified.
    expect(matchSectionHeader("Spoken Languages")).toBeNull();
  });
});

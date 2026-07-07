// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { runRegexFallback } from "./regex-fallback.ts";
import type { HeuristicParsedResume, FieldConfidence } from "./types.ts";

function emptyParsed(): HeuristicParsedResume {
  return {
    skills: [],
    skills_explicit: [],
    skills_inferred: [],
    experience: [],
    education: [],
  };
}

describe("runRegexFallback", () => {
  it("fills email, phone, and linkedin when Tier 1 missed them", () => {
    const rawText = [
      "Jane Q. Doe",
      "Senior Software Engineer",
      "jane.doe@example.com · (415) 555-0123",
      "https://www.linkedin.com/in/janeqdoe",
    ].join("\n");

    const result = runRegexFallback(emptyParsed(), {}, rawText);
    expect(result.parsed.email).toBe("jane.doe@example.com");
    expect(result.parsed.phone).toBeDefined();
    expect(result.parsed.linkedin_url).toMatch(/linkedin\.com\/in\/janeqdoe/);
    expect(result.fieldsFilled).toEqual(
      expect.arrayContaining(["email", "phone", "linkedin_url"]),
    );
  });

  it("never overwrites a field Tier 1 already populated", () => {
    const parsed: HeuristicParsedResume = {
      ...emptyParsed(),
      email: "already@set.com",
    };
    const rawText = "jane.doe@example.com · https://linkedin.com/in/jane";
    const confidence: FieldConfidence = { email: 0.9 };
    const result = runRegexFallback(parsed, confidence, rawText);
    expect(result.parsed.email).toBe("already@set.com");
    expect(result.fieldConfidence.email).toBe(0.9);
    expect(result.fieldsFilled).not.toContain("email");
  });

  it("guesses a title-case name only when Tier 1 had none", () => {
    const rawText = [
      "Jordan Rivera",
      "Senior Software Engineer",
      "jordan@example.com",
    ].join("\n");
    const result = runRegexFallback(emptyParsed(), {}, rawText);
    expect(result.parsed.full_name).toBe("Jordan Rivera");
    expect(result.parsed.given_name).toBe("Jordan");
    expect(result.parsed.family_name).toBe("Rivera");
  });

  it("skips the name guess when the first line has digits", () => {
    const rawText = "Section 1 Summary\nJane Doe — janedoe@example.com";
    const result = runRegexFallback(emptyParsed(), {}, rawText);
    // Second line has em-dash + email → not a clean title-case match.
    expect(result.parsed.full_name).toBeUndefined();
  });

  it("rejects a phone match with fewer than 10 digits", () => {
    const rawText = "Short phone: 555-1234";
    const result = runRegexFallback(emptyParsed(), {}, rawText);
    expect(result.parsed.phone).toBeUndefined();
  });

  it("falls back to LinkedIn from annotations when text has no URL match", () => {
    // Tier 1 missed it (no `LINKEDIN_RE` match), so Tier 1.5 runs. The
    // raw text contains the visible word "LinkedIn" but not the URL.
    const rawText = [
      "Mohin Patel",
      "973-452-3653 | mohinp@uw.edu | LinkedIn | GitHub",
    ].join("\n");
    const result = runRegexFallback(emptyParsed(), {}, rawText, [
      {
        page: 1,
        url: "https://www.linkedin.com/in/mohin-patel/",
        rect: [0, 0, 100, 20],
        yTop: 80,
      },
    ]);
    expect(result.parsed.linkedin_url).toBe(
      "https://www.linkedin.com/in/mohin-patel/",
    );
    expect(result.fieldConfidence.linkedin_url).toBeCloseTo(0.95, 5);
    expect(result.fieldsFilled).toContain("linkedin_url");
  });

  it("prefers visible text LinkedIn over annotation when both exist", () => {
    const rawText = "https://linkedin.com/in/from-text · LinkedIn";
    const result = runRegexFallback(emptyParsed(), {}, rawText, [
      {
        page: 1,
        url: "https://www.linkedin.com/in/from-annotation/",
        rect: [0, 0, 100, 20],
        yTop: 80,
      },
    ]);
    expect(result.parsed.linkedin_url).toContain("from-text");
  });

  it("refuses to promote a job title to full_name (#349 round-trip)", () => {
    // The reconstructed Download PDF for a name-less Deedy re-parses with
    // "Software Engineer" as the first title-case candidate — the top role
    // title moves into the header slot when no name is rendered above it.
    // A job-title tagline is never a person's name.
    const rawText = ["Software Engineer", "jane.smith@example.com"].join("\n");
    const result = runRegexFallback(emptyParsed(), {}, rawText);
    expect(result.parsed.full_name).toBeUndefined();
    expect(result.fieldsFilled).not.toContain("full_name");
  });

  it("refuses to promote an education institution to full_name (#349)", () => {
    // Deedy-style two-column flatten: the real name (centred at the top) is
    // pushed past the first-lines window by the column reorder, leaving an
    // all-caps education entry as the first title-case candidate. Both tokens
    // match the loose title-case pattern and passed every other guard, so the
    // fallback used to write "CORNELL UNIVERSITY" as full_name @ 0.5. A
    // false-positive name is worse than a missing one — it earns undeserved
    // completeness credit and displays a wrong name in the reconstructed PDF.
    const rawText = [
      "jane.smith@example.com | (312) 555-0123",
      "EDUCATION",
      "CORNELL UNIVERSITY",
      "MEng in Computer Science",
    ].join("\n");
    const result = runRegexFallback(emptyParsed(), {}, rawText);
    expect(result.parsed.full_name).toBeUndefined();
    expect(result.fieldsFilled).not.toContain("full_name");
  });
});

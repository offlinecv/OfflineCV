// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { extractContact, extractName } from "./extract-fields.ts";
import { groupIntoLines, splitIntoSections, findSection } from "./sections.ts";
import { US_LOCATION_RE } from "./regex.ts";
import type { PdfLinkAnnotation } from "./types.ts";
import { mkItems, mkDefaultPages } from "./__test-utils__/mkItem.ts";

void mkDefaultPages; // imported for parity with sibling tests

function buildContext(specs: Array<{ text: string; fontSize?: number }>) {
  const items = mkItems(specs);
  const lines = groupIntoLines(items);
  const sections = splitIntoSections(lines);
  const profile = findSection(sections, "profile") ?? {
    name: "profile" as const,
    lines: [],
  };
  return { lines, profile };
}

describe("extractContact — annotation fallback for hyperlinked URLs", () => {
  it("recovers LinkedIn from a Link annotation when visible text is just 'LinkedIn'", () => {
    // LaTeX/Jake's-Resume convention: the URL is hyperlinked behind the
    // word "LinkedIn", so pdfjs's text path returns just the word and
    // LINKEDIN_RE finds nothing in the text.
    const { lines, profile } = buildContext([
      { text: "Mohin Patel", fontSize: 18 },
      { text: "973-452-3653 | mohinp@uw.edu | LinkedIn | GitHub", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Some company role", fontSize: 11 },
    ]);
    const annotations: PdfLinkAnnotation[] = [
      {
        page: 1,
        url: "https://www.linkedin.com/in/mohin-patel/",
        rect: [307, 720, 348, 734],
        yTop: 80, // top of page → in profile band
      },
      {
        page: 1,
        url: "https://github.com/mohinpatell",
        rect: [355, 720, 390, 734],
        yTop: 80,
      },
    ];

    const contact = extractContact(profile, lines, annotations);
    expect(contact.linkedin_url).toBe(
      "https://www.linkedin.com/in/mohin-patel/",
    );
    expect(contact.github_url).toBe("https://github.com/mohinpatell");
    expect(contact.confidence.linkedin_url).toBeCloseTo(0.95, 5);
    expect(contact.confidence.github_url).toBeCloseTo(0.95, 5);
    // Email still comes from text.
    expect(contact.email).toBe("mohinp@uw.edu");
  });

  it("does not pull a footer LinkedIn annotation into the candidate's profile", () => {
    // A LinkedIn URL that lives in the body of a project section (e.g.
    // referenced as a citation) should not be misattributed as the
    // candidate's profile. The y-band filter restricts the lookup to
    // annotations above the first section header.
    const { lines, profile } = buildContext([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Recommendation from LinkedIn at https://linkedin.com/in/someone-else", fontSize: 11 },
    ]);
    const annotations: PdfLinkAnnotation[] = [
      {
        page: 1,
        // y past the EXPERIENCE header — outside the profile band.
        url: "https://www.linkedin.com/in/someone-else/",
        rect: [200, 200, 300, 215],
        yTop: 600,
      },
    ];
    const contact = extractContact(profile, lines, annotations);
    // The text version above the regex would catch it from the body line,
    // but the location/profile annotation logic specifically should not
    // adopt the URL as the candidate's. Since `LINKEDIN_RE` can match the
    // URL in the experience body line via fallback scan, we accept that —
    // the regression we're guarding is that the annotation system does
    // not contribute its own band-violating hit. Validate by removing
    // the visible URL and checking annotation alone is rejected.
    void contact; // suppress unused
    const annotationsOnly = buildContext([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Plain body line with no URL.", fontSize: 11 },
    ]);
    const result = extractContact(
      annotationsOnly.profile,
      annotationsOnly.lines,
      [
        {
          page: 1,
          url: "https://www.linkedin.com/in/footer-only/",
          rect: [200, 200, 300, 215],
          yTop: 600, // below EXPERIENCE header
        },
      ],
    );
    expect(result.linkedin_url).toBeUndefined();
    expect(result.confidence.linkedin_url).toBe(0);
  });

  it("never overwrites a text-extracted URL with an annotation hit", () => {
    const { lines, profile } = buildContext([
      { text: "Jane Doe", fontSize: 18 },
      { text: "https://linkedin.com/in/from-text", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Role", fontSize: 11 },
    ]);
    const result = extractContact(profile, lines, [
      {
        page: 1,
        url: "https://www.linkedin.com/in/from-annotation/",
        rect: [0, 0, 100, 20],
        yTop: 80,
      },
    ]);
    expect(result.linkedin_url).toContain("from-text");
  });
});

describe("extractContact — location no longer falls back to document-wide scan", () => {
  it("returns undefined when header has no city/state, even if Education contains 'Seattle, WA'", () => {
    // Mohin's PDF case: the column-merged Education line groups
    // "University of Washington, Paul G. Allen School of CS and Engineering    Seattle, WA"
    // into one PdfLine. Pre-fix, `extractContact`'s document-wide fallback
    // captured "CS and Engineering Seattle, WA" as the candidate's location.
    const { lines, profile } = buildContext([
      { text: "Mohin Patel", fontSize: 18 },
      { text: "973-452-3653 | mohinp@uw.edu", fontSize: 10 },
      { text: "" },
      { text: "EDUCATION", fontSize: 13 },
      {
        text: "University of Washington, Paul G. Allen School of CS and Engineering    Seattle, WA",
        fontSize: 11,
      },
    ]);
    const contact = extractContact(profile, lines);
    expect(contact.location).toBeUndefined();
    expect(contact.confidence.location).toBe(0);
  });

  it("still extracts a location when it IS in the profile header", () => {
    const { lines, profile } = buildContext([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com · San Francisco, CA", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp Jan 2022 - Present", fontSize: 11 },
    ]);
    const contact = extractContact(profile, lines);
    expect(contact.location).toContain("San Francisco");
    expect(contact.confidence.location).toBeGreaterThan(0);
  });
});

describe("extractName — document-title boilerplate rejection (issue #10)", () => {
  it("picks the real name when a 'Functional Resume Sample' header is above it", () => {
    // Mode 1 of issue #10: a public Microsoft-style sample template renders
    // the doc title in the largest font on the first profile line, which the
    // original selector scored at 1.0 — choosing the boilerplate as the name.
    const { profile } = buildContext([
      { text: "Functional Resume Sample", fontSize: 22 },
      { text: "Jane Smith", fontSize: 14 },
      { text: "jane.smith@example.com · (555) 010-0123", fontSize: 10 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
    ]);
    const result = extractName(profile);
    expect(result.value).toBe("Jane Smith");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("rejects 'Curriculum Vitae' as a name candidate", () => {
    const { profile } = buildContext([
      { text: "Curriculum Vitae", fontSize: 22 },
      { text: "Jane Smith", fontSize: 14 },
      { text: "jane.smith@example.com", fontSize: 10 },
    ]);
    expect(extractName(profile).value).toBe("Jane Smith");
  });

  it("rejects 'Resume Sample' as a name candidate (all tokens are boilerplate)", () => {
    const { profile } = buildContext([
      { text: "Resume Sample", fontSize: 22 },
      { text: "Jane Smith", fontSize: 14 },
      { text: "jane.smith@example.com", fontSize: 10 },
    ]);
    expect(extractName(profile).value).toBe("Jane Smith");
  });

  it("still picks 'Jane Smith Resume' (only 1 of 3 tokens is boilerplate)", () => {
    // Conservative filter — a real name with the word "Resume" appended must
    // still pass. Only ≥60% boilerplate triggers rejection.
    const { profile } = buildContext([
      { text: "Jane Smith Resume", fontSize: 18 },
      { text: "jane.smith@example.com", fontSize: 10 },
    ]);
    expect(extractName(profile).value).toBe("Jane Smith Resume");
  });

  it("no regression: still picks a top-line name when no boilerplate is present", () => {
    const { profile } = buildContext([
      { text: "Mohin Patel", fontSize: 18 },
      { text: "mohinp@uw.edu | 973-452-3653", fontSize: 10 },
      { text: "" },
      { text: "EDUCATION", fontSize: 13 },
    ]);
    const result = extractName(profile);
    expect(result.value).toBe("Mohin Patel");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("boilerplate-rejected name still picks up the contact-cluster proximity bonus on the runner-up", () => {
    // Regression on the proximity signal itself: when the obvious first-line
    // candidate is rejected as boilerplate, the proximity bonus must still
    // fire for the surviving candidate. Otherwise we'd lose a confidence
    // signal that's most useful precisely in the issue-10 scenario.
    const { profile } = buildContext([
      { text: "Functional Resume Sample", fontSize: 22 },
      { text: "Jane Smith", fontSize: 14 },
      { text: "jane.smith@example.com", fontSize: 10 },
    ]);
    const result = extractName(profile);
    expect(result.value).toBe("Jane Smith");
    // Must clear ANON_CONTACT_CONFIDENCE_FLOOR (0.5) in score.ts —
    // otherwise completeness scoring marks the (correctly-detected) name as
    // "missing", which is mode 2 of issue #10 manifesting inside the fix
    // for mode 1. Guarded so a future tuning regression on this threshold
    // boundary fails loudly.
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("extractName — name set apart from contact block (issue #16, mode 2)", () => {
  it("prefers the contact-adjacent name over a LARGER job-title tagline above it", () => {
    // Mode 2 of #10/#16: a "Product Designer" tagline renders in a larger font
    // on the first profile line, so position+size alone make it the winner —
    // even though the real name sits one line below, immediately above the
    // contact cluster. The contact-cluster proximity must be strong enough to
    // *change the winner*, not merely nudge confidence.
    const { profile } = buildContext([
      { text: "Product Designer", fontSize: 16 },
      { text: "Jane Smith", fontSize: 12 },
      { text: "jane.smith@example.com", fontSize: 11 },
      { text: "(555) 010-0123", fontSize: 11 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
    ]);
    const result = extractName(profile);
    expect(result.value).toBe("Jane Smith");
    // Must clear ANON_CONTACT_CONFIDENCE_FLOOR (0.5) so completeness scoring
    // doesn't mark the (correctly-detected) name as missing — the exact
    // failure @sriyau64 reported.
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("prefers the contact-adjacent name over a same-size job-title line above it", () => {
    // Same defect without the font cue: a "Senior Marketing Lead" line sits
    // higher at the same size, so it would win the first-line bonus. Proximity
    // to the contact cluster has to overturn that.
    const { profile } = buildContext([
      { text: "Senior Marketing Lead", fontSize: 12 },
      { text: "Jane Smith", fontSize: 12 },
      { text: "jane.smith@example.com", fontSize: 11 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
    ]);
    const result = extractName(profile);
    expect(result.value).toBe("Jane Smith");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("no regression: name + title + contact in reading order still picks the name", () => {
    // The common "Name / Title / contact" stack must be unaffected — the name
    // is the first eligible line and stays the winner even though the title
    // line is closer to the contact cluster.
    const { profile } = buildContext([
      { text: "Jane Smith", fontSize: 18 },
      { text: "Product Designer", fontSize: 12 },
      { text: "jane.smith@example.com", fontSize: 11 },
      { text: "" },
      { text: "EXPERIENCE", fontSize: 13 },
    ]);
    expect(extractName(profile).value).toBe("Jane Smith");
  });
});

describe("US_LOCATION_RE — preposition-phrase city rejection", () => {
  it("does not eat lowercase prepositions like 'and' / 'of' inside the city capture", () => {
    // Pre-fix the regex captured "CS and Engineering Seattle" (26 chars
    // including the lowercase "and"). Post-fix the case-pattern breaks at
    // "and" / "of" / "the", so any match starts at a capitalized token.
    const text = "Paul G. Allen School of CS and Engineering Seattle, WA";
    const match = US_LOCATION_RE.exec(text);
    expect(match).not.toBeNull();
    // The capture must not contain "and" or "of" — those word boundaries
    // were the original bug. Some trailing capitalized noise (e.g.
    // "Engineering Seattle") may remain; that's an upstream tightening
    // problem, but the user-visible bug is the lowercase-preposition
    // capture, which is now impossible.
    expect(match?.[1]).not.toMatch(/\b(and|of|the|in|at)\b/i);
  });

  it("still matches multi-word cities like 'San Francisco, CA'", () => {
    const m = US_LOCATION_RE.exec("Lives in San Francisco, CA proudly");
    expect(m?.[1]).toBe("San Francisco");
    expect(m?.[2]).toBe("CA");
  });

  it("matches 'Salt Lake City, UT' (3 tokens)", () => {
    const m = US_LOCATION_RE.exec("Born in Salt Lake City, UT");
    expect(m?.[1]).toBe("Salt Lake City");
    expect(m?.[2]).toBe("UT");
  });

  it("does not anchor match at a lowercase preposition", () => {
    // "of Engineering Seattle, WA" must not start the capture at "of".
    const m = US_LOCATION_RE.exec("of Engineering Seattle, WA");
    if (m) expect(m[1]).not.toMatch(/^of\b/i);
  });
});

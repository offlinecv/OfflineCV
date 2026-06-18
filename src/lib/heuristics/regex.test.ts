// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { matchSectionHeader, matchSectionAnchorToken, DATE_RANGE_RE } from "./regex.ts";
import { parseDateRange } from "./line-primitives.ts";

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
    // AC pin (#117): the text-only path stays unchanged when the L3 visual
    // recovery lands — "20% Experience" must remain null here. The recovery
    // for "20% Projects" lives in classifyLine's font-gated visual branch via
    // matchSectionAnchorToken, never on this path.
    expect(matchSectionHeader("20% Experience")).toBeNull();
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

describe("DATE_RANGE_RE — separator-less month-year pairs (#119)", () => {
  // Awesome-CV / LaTeX templates: pdfjs drops the dash glyph entirely, leaving
  // a bare space between the two month-year anchors. Branch (b) of DATE_RANGE_RE
  // must match without any – / — / - / to / through separator.

  it("matches a bare space-separated month-year pair", () => {
    expect(DATE_RANGE_RE.test("Sep. 2023 Mar. 2024")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("matches additional separator-less cases", () => {
    expect(DATE_RANGE_RE.test("Mar. 2021 Jun. 2023")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
    expect(DATE_RANGE_RE.test("Jun. 2017 May. 2018")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("matches a separator-less range embedded in a title-bearing line", () => {
    // e.g. "Site Reliability Engineer Feb. 2021 Mar. 2021"
    expect(DATE_RANGE_RE.test("Site Reliability Engineer Feb. 2021 Mar. 2021")).toBe(
      true,
    );
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("parseDateRange extracts correct start and end dates (sep-less)", () => {
    const result = parseDateRange("Sep. 2023 Mar. 2024");
    expect(result.start_date).toBe("Sep. 2023");
    expect(result.end_date).toBe("Mar. 2024");
    expect(result.is_current).toBeUndefined();
  });

  it("parseDateRange extracts is_current when end is Present (sep-less)", () => {
    const result = parseDateRange("Feb. 2022 Present");
    expect(result.start_date).toBe("Feb. 2022");
    expect(result.is_current).toBe(true);
  });

  it("does NOT match bare adjacent years (too weak a signal)", () => {
    // "shipped 2020 2021 release" must not fire the separator-less branch.
    const m = DATE_RANGE_RE.exec("shipped 2020 2021 release");
    DATE_RANGE_RE.lastIndex = 0;
    expect(m).toBeNull();
  });

  it("existing dash-separator ranges still parse correctly (branch a)", () => {
    // Regression guard: classic dash branch must be byte-identical.
    const result = parseDateRange("Jan 2019 – Dec 2021");
    expect(result.start_date).toBe("Jan 2019");
    expect(result.end_date).toBe("Dec 2021");
  });

  it("existing 'to'-separator ranges still parse correctly (branch a)", () => {
    const result = parseDateRange("Mar. 2020 to Jun. 2023");
    expect(result.start_date).toBe("Mar. 2020");
    expect(result.end_date).toBe("Jun. 2023");
  });

  it("existing Present ranges still parse correctly (branch a)", () => {
    const result = parseDateRange("Apr 2021 – Present");
    expect(result.start_date).toBe("Apr 2021");
    expect(result.is_current).toBe(true);
  });
});

describe("matchSectionAnchorToken — visual-path trailing anchor (#117)", () => {
  it("recovers a section from a sidebar artifact glued onto the header", () => {
    // The two-column flatten that motivates #117: a sidebar value `20%` is
    // glued onto the real `Projects` header. The trailing token is the anchor,
    // so the unguarded lookup recovers `projects`. (The font signal at the call
    // site is what licenses skipping the prose guards.)
    expect(matchSectionAnchorToken("20% Projects")).toBe("projects");
  });

  it("recovers past a leading noise-prefix glyph", () => {
    // A leading bullet/box glyph is a sidebar/list artifact, not a prose marker
    // on this font-gated path; the trailing anchor still wins.
    expect(matchSectionAnchorToken("▪ Experience")).toBe("experience");
  });

  it("does NOT match a section whose anchorFallback is false (skills)", () => {
    // `skills` has anchorFallback:false in the config, so even though `skills`
    // is its anchor, the trailing-token lookup must reject it — matching the
    // text-only path's treatment.
    expect(matchSectionAnchorToken("Random Skills")).toBeNull();
  });

  it("returns null when the last token is not an anchor", () => {
    expect(matchSectionAnchorToken("just some prose")).toBeNull();
  });
});

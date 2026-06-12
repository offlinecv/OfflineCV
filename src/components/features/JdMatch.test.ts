// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JdMatch } from "./JdMatch.tsx";
import type { ExtractedTerm } from "../../lib/jd-match/extract-jd-terms.ts";
import type { CoverageResult } from "../../lib/jd-match/coverage.ts";

function term(
  id: string,
  display: string,
  source: ExtractedTerm["source"],
): ExtractedTerm {
  return { id, display, source, snippet: `…snippet for ${display}…` };
}

describe("JdMatch", () => {
  it("renders an N-of-M headline rather than a percent-match label", () => {
    const covered = [term("react", "react", "skill")];
    const missing = [
      term("kubernetes", "kubernetes", "skill"),
      term("Distributed Systems", "Distributed Systems", "noun"),
    ];
    const terms = [...covered, ...missing];
    const coverage: CoverageResult = {
      covered,
      missing,
      score: 25,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(createElement(JdMatch, { coverage, terms }));
    expect(html).toContain("Your resume mentions 1 of 3 terms from this JD.");
    expect(html).not.toMatch(/\d+%\s*match/i);
  });

  it("flags the diagnostic framing, not 'will pass ATS' framing", () => {
    const coverage: CoverageResult = {
      covered: [],
      missing: [],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(createElement(JdMatch, { coverage, terms: [] }));
    expect(html.toLowerCase()).toContain("diagnostic, not a verdict");
    expect(html.toLowerCase()).not.toMatch(/will\s+(pass|fail)/);
    expect(html.toLowerCase()).not.toContain("ats");
  });

  it("renders covered and missing terms with their display strings", () => {
    const covered = [term("react", "react", "skill")];
    const missing = [term("kubernetes", "kubernetes", "skill")];
    const terms = [...covered, ...missing];
    const coverage: CoverageResult = {
      covered,
      missing,
      score: 50,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(createElement(JdMatch, { coverage, terms }));
    expect(html).toContain("Covered (1)");
    expect(html).toContain("Missing (1)");
    expect(html).toContain(">react<");
    expect(html).toContain(">kubernetes<");
  });

  it("surfaces the '+N more' footnote when noun-pass cap silences hits", () => {
    const coverage: CoverageResult = {
      covered: [],
      missing: [],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { coverage, terms: [], nounsDropped: 7 }),
    );
    expect(html).toContain("+7 more capitalized phrases");
  });

  it("omits the footnote when no hits were silenced", () => {
    const coverage: CoverageResult = {
      covered: [],
      missing: [],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { coverage, terms: [], nounsDropped: 0 }),
    );
    expect(html).not.toContain("not surfaced");
    expect(html).not.toContain("not shown");
    expect(html).not.toMatch(/\+\d+ more/);
  });

  it("emits the snippet on the term row as a hover tooltip (title attribute)", () => {
    const t = term("react", "react", "skill");
    const coverage: CoverageResult = {
      covered: [t],
      missing: [],
      score: 100,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { coverage, terms: [t] }),
    );
    expect(html).toContain(`title="${t.snippet}"`);
  });
});

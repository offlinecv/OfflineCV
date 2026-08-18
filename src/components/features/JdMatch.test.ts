// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JdMatch } from "./JdMatch.tsx";
import type { ExtractedTerm } from "../../lib/jd-match/extract-jd-terms.ts";
import type { CoverageResult } from "../../lib/jd-match/coverage.ts";
import type { JdMatchResult } from "../../lib/jd-match";

function term(
  id: string,
  display: string,
  source: ExtractedTerm["source"],
): ExtractedTerm {
  return { id, display, source, snippet: `…snippet for ${display}…` };
}

/** A single covered skill term, shared by the two tests that only need "one
 *  term, fully covered" — kept as one fixture so the identical eleven-line
 *  setup isn't written twice. */
const ONE_TERM = term("react", "react", "skill");

/** That term as a fully-covered keyword result. */
function fullyCovered(): JdMatchResult {
  return kw(
    {
      covered: [ONE_TERM],
      missing: [],
      score: 100,
      weights: { skill: 1, noun: 0.5 },
    },
    [ONE_TERM],
  );
}

/** Wrap a keyword-path coverage result in the path-agnostic union (#199). */
function kw(
  coverage: CoverageResult,
  terms: readonly ExtractedTerm[],
  nounsDropped = 0,
): JdMatchResult {
  return { path: "keyword", coverage, terms, nounsDropped };
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
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: kw(coverage, terms) }),
    );
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
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: kw(coverage, []) }),
    );
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
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: kw(coverage, terms) }),
    );
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
      createElement(JdMatch, { result: kw(coverage, [], 7) }),
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
      createElement(JdMatch, { result: kw(coverage, [], 0) }),
    );
    expect(html).not.toContain("not surfaced");
    expect(html).not.toContain("not shown");
    expect(html).not.toMatch(/\+\d+ more/);
  });

  it("emits the snippet on the term row as a hover tooltip (title attribute)", () => {
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: fullyCovered() }),
    );
    expect(html).toContain(`title="${ONE_TERM.snippet}"`);
  });

  it("routes the semantic path to the verdict view instead of rendering null", () => {
    // The pre-#204 behaviour was `return null` for anything not `keyword`, so
    // a finished on-device match rendered a blank panel. This is the assertion
    // that would fail if the router regressed to that.
    const result: JdMatchResult = {
      path: "semantic",
      verdicts: [
        {
          requirement: { id: "req-1", kind: "skill", text: "Ship Kubernetes" },
          status: "met",
          reason: "Ran production clusters at Acme.",
        },
      ],
      summary: { met: 1, partial: 0, missing: 0, total: 1 },
    };
    const html = renderToStaticMarkup(createElement(JdMatch, { result }));
    expect(html).not.toBe("");
    expect(html).toContain("Ship Kubernetes");
    expect(html).toContain("1 met · 0 partial · 0 missing");
    // …and it is the SEMANTIC view, not the keyword one dressed up: the
    // keyword-only headline and its matcher disclaimer must be absent.
    expect(html).not.toContain("terms from this JD");
    expect(html).not.toContain("we don&#x27;t read context");
  });

  it("routes the keyword path away from the semantic view", () => {
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: fullyCovered() }),
    );
    expect(html).toContain("Your resume mentions 1 of 1 terms from this JD.");
    expect(html).not.toContain("met ·");
  });
});

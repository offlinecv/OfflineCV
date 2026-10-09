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
      missing: [ONE_TERM],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: kw(coverage, [ONE_TERM]) }),
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
      missing: [ONE_TERM],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: kw(coverage, [ONE_TERM], 7) }),
    );
    expect(html).toContain("+7 more capitalized phrases");
  });

  it("omits the footnote when no hits were silenced", () => {
    const coverage: CoverageResult = {
      covered: [],
      missing: [ONE_TERM],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: kw(coverage, [ONE_TERM], 0) }),
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

  it("renders no eligibility block when the result carries none (#793)", () => {
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: fullyCovered() }),
    );
    expect(html).not.toContain("Eligibility language in this JD");
  });

  it("renders a quoted eligibility finding above the coverage card, for either arm (#793)", () => {
    const snippet = "…we are unable to sponsor employment visas…";
    const keywordResult = {
      ...fullyCovered(),
      eligibility: [{ kind: "no-sponsorship" as const, snippet }],
    };
    const html = renderToStaticMarkup(
      createElement(JdMatch, { result: keywordResult }),
    );
    expect(html).toContain("Visa sponsorship");
    expect(html).toContain(snippet);
    // Above the coverage card, not inside it.
    expect(html.indexOf("Visa sponsorship")).toBeLessThan(
      html.indexOf("terms from this JD"),
    );
    // The copy reports, never judges.
    expect(html.toLowerCase()).not.toContain("not eligible");
    expect(html.toLowerCase()).not.toContain("you are");
  });

  it("names the topic, never a polarity, even when the detector's polarity guess for `kind` is wrong (review on #1175)", () => {
    // Both sentences are genuine JD text where the bare `kind` the detector
    // assigns does not reliably match what the sentence actually says — one
    // is an affirmative sponsorship offer, the other explicitly says
    // sponsorship ISN'T the issue. A headline that stated a polarity ("No
    // visa sponsorship") would risk asserting the opposite of the JD; naming
    // only the topic can't.
    const sentences = [
      "Sponsorship is not an issue for us; we sponsor H-1B.",
      "We provide visa sponsorship at no cost to you.",
    ];
    for (const snippet of sentences) {
      const keywordResult = {
        ...fullyCovered(),
        eligibility: [{ kind: "no-sponsorship" as const, snippet }],
      };
      const html = renderToStaticMarkup(
        createElement(JdMatch, { result: keywordResult }),
      );
      // The neutral topic label is present…
      expect(html).toContain("Visa sponsorship");
      // …and nothing anywhere states a polarity on the JD's behalf.
      expect(html).not.toContain("No visa sponsorship");
      expect(html.toLowerCase()).not.toContain("no sponsorship");
      expect(html.toLowerCase()).not.toContain("sponsorship available");
    }
  });

  it("does not render the keyword card when a JD has only eligibility language and zero terms", () => {
    // Before this fix, a zero-term keyword result still rendered the whole
    // card: "0 of 0 terms", "0/100", and both columns' empty-state copy —
    // noise below an eligibility block that already said the one thing the
    // JD stated.
    const coverage: CoverageResult = {
      covered: [],
      missing: [],
      score: 0,
      weights: { skill: 1, noun: 0.5 },
    };
    const result: JdMatchResult = {
      path: "keyword",
      coverage,
      terms: [],
      nounsDropped: 0,
      eligibility: [
        { kind: "no-sponsorship", snippet: "…we are unable to sponsor…" },
      ],
    };
    const html = renderToStaticMarkup(createElement(JdMatch, { result }));
    expect(html).toContain("Visa sponsorship");
    expect(html).not.toContain("terms from this JD");
    expect(html).not.toContain("0/100");
    expect(html).not.toContain("Every term we extracted shows up");
  });
});

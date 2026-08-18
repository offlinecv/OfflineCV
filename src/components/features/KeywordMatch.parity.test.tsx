// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * KeywordMatch parity (#204) — the keyword view is the DEFAULT experience.
 *
 * #204 turned `JdMatch` into a router and moved its body into `KeywordMatch`.
 * The sibling `JdMatch.test.ts` asserts the behaviours a reader cares about
 * (N-of-M headline, diagnostic framing, the `+N more` footnote); this file
 * asserts the thing those tests CAN'T catch — that the move changed no markup
 * at all. A dropped wrapper, a reordered class, a lost `title`, a re-tuned gap
 * would all pass a behavioural assertion and still be a visual regression for
 * every user who never opts into on-device analysis.
 *
 * The golden strings below were captured by rendering the PRE-#204
 * `JdMatch.tsx` (`git show HEAD~:…`) against these three inputs, not by
 * snapshotting the new component — a self-captured snapshot would pass no
 * matter what the refactor did. Three inputs because they exercise the three
 * branches the view has: populated columns + footnote, both empty-state
 * copies, and the singular/plural fork in the footnote.
 *
 * If a future change to the keyword view is INTENDED, update these strings in
 * the same commit; the point is that it cannot happen by accident.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JdMatch } from "./JdMatch.tsx";
import type { ExtractedTerm } from "../../lib/jd-match/extract-jd-terms.ts";
import type { JdMatchResult } from "../../lib/jd-match";

function term(
  id: string,
  display: string,
  source: ExtractedTerm["source"],
): ExtractedTerm {
  return { id, display, source, snippet: `…snippet for ${display}…` };
}

const covered = [
  term("react", "react", "skill"),
  term("Distributed Systems", "Distributed Systems", "noun"),
];
const missing = [term("kubernetes", "kubernetes", "skill")];

function keyword(nounsDropped: number): JdMatchResult {
  return {
    path: "keyword",
    coverage: {
      covered,
      missing,
      score: 62,
      weights: { skill: 1, noun: 0.5 },
    },
    terms: [...covered, ...missing],
    nounsDropped,
  };
}

const EMPTY: JdMatchResult = {
  path: "keyword",
  coverage: {
    covered: [],
    missing: [],
    score: 0,
    weights: { skill: 1, noun: 0.5 },
  },
  terms: [],
  nounsDropped: 0,
};

const POPULATED_HTML =
  '<section class="rounded-xl border border-border-light bg-surface-card p-5 flex flex-col gap-4 shadow-xs"><header class="flex flex-col gap-1"><div class="flex items-baseline gap-2"><h2 class="text-sm font-semibold uppercase tracking-wider text-content-muted">JD match</h2><span class="rounded bg-surface-subtle px-1.5 py-0.5 text-4xs font-semibold uppercase tracking-wider text-content-secondary">alpha</span></div><p class="text-base font-semibold text-content-primary">Your resume mentions 2 of 3 terms from this JD.</p><p class="text-sm text-content-tertiary">Weighted coverage: <span class="font-mono text-content-secondary">62/100</span> — skill 1.0, phrase 0.5.</p><p class="max-w-prose text-sm text-content-tertiary">Diagnostic, not a verdict. We look for skills and phrases by name — we don&#x27;t read context. Your JD text stays in this browser tab.</p></header><div class="grid gap-4 md:grid-cols-2"><section class="flex flex-col gap-2"><h3 class="text-sm font-semibold uppercase tracking-wider text-content-muted">Covered (2)</h3><ul class="flex flex-col gap-1"><li class="flex items-baseline gap-2 rounded border border-border-light px-2 py-1.5" title="…snippet for react…"><span class="text-sm font-semibold text-feedback-success-text">✓</span><span class="text-sm text-content-primary">react</span><span class="ml-auto font-mono text-3xs uppercase tracking-wider text-content-muted">skill</span></li><li class="flex items-baseline gap-2 rounded border border-border-light px-2 py-1.5" title="…snippet for Distributed Systems…"><span class="text-sm font-semibold text-feedback-success-text">✓</span><span class="text-sm text-content-primary">Distributed Systems</span><span class="ml-auto font-mono text-3xs uppercase tracking-wider text-content-muted">phrase</span></li></ul></section><section class="flex flex-col gap-2"><h3 class="text-sm font-semibold uppercase tracking-wider text-content-muted">Missing (1)</h3><ul class="flex flex-col gap-1"><li class="flex items-baseline gap-2 rounded border border-border-light px-2 py-1.5" title="…snippet for kubernetes…"><span class="text-sm font-semibold text-content-muted">•</span><span class="text-sm text-content-primary">kubernetes</span><span class="ml-auto font-mono text-3xs uppercase tracking-wider text-content-muted">skill</span></li></ul></section></div><p class="text-2xs text-content-muted">+3 more capitalized phrases in this JD weren&#x27;t surfaced — the noun-phrase pass ranks hits by how often they recur (weighting the requirements section) and keeps the top ones to keep the panel readable.</p></section>';

const EMPTY_HTML =
  '<section class="rounded-xl border border-border-light bg-surface-card p-5 flex flex-col gap-4 shadow-xs"><header class="flex flex-col gap-1"><div class="flex items-baseline gap-2"><h2 class="text-sm font-semibold uppercase tracking-wider text-content-muted">JD match</h2><span class="rounded bg-surface-subtle px-1.5 py-0.5 text-4xs font-semibold uppercase tracking-wider text-content-secondary">alpha</span></div><p class="text-base font-semibold text-content-primary">Your resume mentions 0 of 0 terms from this JD.</p><p class="text-sm text-content-tertiary">Weighted coverage: <span class="font-mono text-content-secondary">0/100</span> — skill 1.0, phrase 0.5.</p><p class="max-w-prose text-sm text-content-tertiary">Diagnostic, not a verdict. We look for skills and phrases by name — we don&#x27;t read context. Your JD text stays in this browser tab.</p></header><div class="grid gap-4 md:grid-cols-2"><section class="flex flex-col gap-2"><h3 class="text-sm font-semibold uppercase tracking-wider text-content-muted">Covered (0)</h3><p class="text-sm text-content-tertiary">None of the JD terms we extracted show up in the resume text.</p></section><section class="flex flex-col gap-2"><h3 class="text-sm font-semibold uppercase tracking-wider text-content-muted">Missing (0)</h3><p class="text-sm text-content-tertiary">Every term we extracted shows up somewhere in the resume.</p></section></div></section>';

/** Only the footnote differs from POPULATED_HTML — pinned in full anyway, so
 *  a change that "fixes" one case and breaks the other can't slip through. */
const SINGULAR_FOOTNOTE_HTML = POPULATED_HTML.replace(
  "+3 more capitalized phrases in this JD",
  "+1 more capitalized phrase in this JD",
);

describe("KeywordMatch parity with the pre-#204 JdMatch body", () => {
  it("renders populated columns and the plural footnote unchanged", () => {
    expect(renderToStaticMarkup(<JdMatch result={keyword(3)} />)).toBe(
      POPULATED_HTML,
    );
  });

  it("renders both empty-state copies unchanged, with no footnote", () => {
    expect(renderToStaticMarkup(<JdMatch result={EMPTY} />)).toBe(EMPTY_HTML);
  });

  it("keeps the singular footnote fork unchanged", () => {
    expect(renderToStaticMarkup(<JdMatch result={keyword(1)} />)).toBe(
      SINGULAR_FOOTNOTE_HTML,
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The copy rule for `/jobs/`, in one place (#597).
 *
 * `term-quality.ts` established the rule and asserts its own `REASONS` /
 * `COHERENCE_NOTES`: a string that ships to a user names a CONSEQUENCE and
 * never the mechanism behind it — no "token", no "gate", no "profile", no
 * issue numbers. #597 added user-facing copy on three more surfaces, and a rule
 * enforced only where it was born is a rule that decays: the next phrase gets
 * written in a component, where nothing checks it.
 *
 * So every module that composes its own copy for this lane exports the strings
 * it can render, and this file is the single assertion over all of them. Adding
 * a surface means adding its export here — which is the point. Copy that comes
 * VERBATIM from `term-quality.ts` (`TermVerdict.reason`, `CoherenceFinding.note`)
 * is deliberately absent: that module already asserts it, and re-asserting it
 * here would imply these components may edit it, which they may not.
 */

import { describe, expect, it } from "vitest";
import { QUERY_STEP_COPY } from "../../lib/job-search/query-steps.ts";
import { SEARCH_PLAN_COPY } from "../../lib/job-search/search-plan.ts";
import { TERM_GLYPH_LEGEND_COPY } from "./TermGlyphLegend.tsx";
import { TERM_ADVISORY_COPY } from "./TermQualityAdvisory.tsx";

/** The same denylist `term-quality.test.ts` applies, plus the internal nouns
 *  #597 names explicitly (`token`, `provider`, `egress`). */
const MECHANISM =
  /tokenizer|token|filter|regex|gate|profile|resolver|admission|provider|egress|#/i;

const SURFACES: readonly { name: string; copy: readonly string[] }[] = [
  { name: "search plan card", copy: SEARCH_PLAN_COPY },
  { name: "term glyph legend", copy: TERM_GLYPH_LEGEND_COPY },
  { name: "term quality advisory", copy: TERM_ADVISORY_COPY },
  { name: "query step rail", copy: QUERY_STEP_COPY },
];

describe("job-search copy", () => {
  for (const { name, copy } of SURFACES) {
    describe(name, () => {
      it("names a consequence, never the mechanism", () => {
        for (const line of copy) expect(line).not.toMatch(MECHANISM);
      });

      it("is never empty", () => {
        expect(copy.length).toBeGreaterThan(0);
        for (const line of copy) expect(line.trim().length).toBeGreaterThan(0);
      });
    });
  }

  it("would catch a mechanism word, so the assertion is load-bearing", () => {
    expect("we ran your résumé through the role profile").toMatch(MECHANISM);
    expect("only your search keywords are sent").not.toMatch(MECHANISM);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Path-agnostic JD-match result type (issue #199, anchor #156 — "JD Matching v2").
 *
 * One stable shape the renderer (`JdMatch.tsx`) can consume regardless of how the
 * match was produced. The `path` discriminant lets a consumer narrow without
 * branching on internals.
 *
 * The semantic arm carries the judge's verdicts verbatim (#201) — the
 * `RequirementVerdict` import is TYPE-ONLY, so this module (reached statically
 * through the `jd-match` barrel by the JD-fit entry) adds no runtime edge into
 * the WebLLM chunk. The producer is `llm/run-llm-match.ts` (#202), which
 * consumers dynamic-import.
 */

import type { CoverageResult } from "./coverage.ts";
import type { EligibilityFinding, ExtractedTerm } from "./extract-jd-terms.ts";
import type { RequirementVerdict } from "./llm/judge-evidence.ts";

/** Per-status verdict counts for the semantic arm — what a headline like
 *  "6 met · 2 partial · 4 missing" renders from without re-tallying. */
export interface SemanticMatchSummary {
  met: number;
  partial: number;
  missing: number;
  total: number;
}

/**
 * A JD-match result from either matching path.
 *
 * - `keyword`  — deterministic term coverage (also the semantic path's fallback).
 * - `semantic` — WebLLM requirement matching (extract #200 → judge #201,
 *                orchestrated by `runLlmMatch` #202).
 */
export type JdMatchResult =
  | {
      path: "keyword";
      coverage: CoverageResult;
      terms: readonly ExtractedTerm[];
      nounsDropped: number;
      /** JD-stated eligibility constraints (#793) — sponsorship /
       *  work-authorization / E-Verify, quoted verbatim. Additive: never
       *  gates or scores anything. Optional so a hand-built fixture/mock
       *  result need not supply it; every real producer does. */
      eligibility?: readonly EligibilityFinding[];
    }
  | {
      path: "semantic";
      verdicts: readonly RequirementVerdict[];
      summary: SemanticMatchSummary;
      /** Same JD-derived findings as the keyword arm's `eligibility` — the
       *  JD doesn't change based on which matching path ran. */
      eligibility?: readonly EligibilityFinding[];
    };

/**
 * The two arms, named once (#866 review).
 *
 * `Extract<JdMatchResult, { path: … }>` was being written out at each site that
 * needed one arm — `KeywordMatch`, `SemanticMatch`, and `job-search/rank.ts`'s
 * own `KeywordJdMatch` — so the idiom was duplicated rather than shared, and a
 * producer whose type is narrower than its declaration (`useJdMatch`'s
 * `keyword`, which by construction only ever builds the keyword arm) had no
 * name to say so with. Declared HERE, beside the union, so a consumer never has
 * to reach into another lane for the type of a value this module produced.
 */
export type KeywordJdMatchResult = Extract<JdMatchResult, { path: "keyword" }>;
export type SemanticJdMatchResult = Extract<JdMatchResult, { path: "semantic" }>;

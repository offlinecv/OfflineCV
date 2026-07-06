// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import type { ExtractedTerm } from "./extract-jd-terms.ts";
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
    }
  | {
      path: "semantic";
      verdicts: readonly RequirementVerdict[];
      summary: SemanticMatchSummary;
    };

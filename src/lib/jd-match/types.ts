// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Path-agnostic JD-match result type (issue #199, anchor #156 — "JD Matching v2").
 *
 * One stable shape the renderer (`JdMatch.tsx`) can consume regardless of how the
 * match was produced. Today only the deterministic `keyword` path exists; M6 will
 * add a WebLLM `semantic` path. The `path` discriminant lets a consumer narrow
 * without branching on internals.
 *
 * This first PR is tagging-only: the keyword arm wraps the existing
 * `extractJdTerms` + `computeCoverage` flow verbatim (no behavior change).
 */

import type { CoverageResult } from "./coverage.ts";
import type { ExtractedTerm } from "./extract-jd-terms.ts";

/**
 * Provisional M6 scaffolding for the semantic arm. Kept NON-exported: nothing
 * imports it yet, so exporting it would trip fallow's unused-export gate. The
 * semantic-path PR will flesh this out (and export it) when it adds a producer.
 */
interface RequirementVerdict {
  requirement: string;
  met: boolean;
  evidence?: string;
}

/**
 * A JD-match result from either matching path.
 *
 * - `keyword`  — deterministic term coverage (the only path that exists today).
 * - `semantic` — WebLLM requirement matching (M6; no producer/UI yet).
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
      summary: { matched: number; total: number };
    };

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import {
  checkNoInjectionLeak,
  compareSemanticVsKeyword,
  emptyJdRubric,
  scoreJdRubric,
  type SemanticVsKeywordComparison,
} from "./jd-rubric.ts";
import type { JdEvalFixture, JdMatchFn } from "./jd-types.ts";
import type { JdRubricResult } from "./jd-rubric.ts";

/**
 * Iterate (model × fixture), invoke `matchFn` for each cell, score with the
 * JD rubric, and emit a structured report. The sibling of `runner.ts` for
 * the JD-match seam (#205) — kept separate rather than generalizing the
 * rewrite runner, because the two iterate different seams (`RewriteFn` over
 * bullets vs. `JdMatchFn` over a JD/résumé pair) and share no per-cell shape.
 *
 * Engine-agnostic like `runner.ts`: a Node test passes a stub `matchFn` that
 * returns each fixture's canned `JdMatchResult` (no model, no WebGPU); the
 * browser entry passes one that dynamic-imports `runLlmMatch`. This file
 * never touches `@mlc-ai/web-llm`, so it is safe in a Node test environment.
 *
 * Failure handling mirrors the rewrite runner: a cell whose `matchFn` throws
 * logs an `error` and scores the empty rubric (every criterion fails) rather
 * than being dropped, so a flaky model can't quietly shrink the denominator.
 */

export interface JdEvalRecord {
  modelId: string;
  fixtureId: string;
  /** `"error"` is a sentinel for a cell whose `matchFn` threw — no keyword
   *  match ran, so it must not be mistaken for a real keyword-arm result. */
  path: "semantic" | "keyword" | "error";
  rubric: JdRubricResult;
  /** `checkNoInjectionLeak` result for a fixture carrying an
   *  `injectionPayload`; `null` for every other fixture (not applicable). */
  injectionSafe: boolean | null;
  /** Set when `matchFn` threw. The row still scores (as a failure) rather
   *  than being silently skipped. */
  error: string | null;
}

export interface JdEvalReport {
  startedAt: string;
  appVersion: string | null;
  modelIds: readonly string[];
  fixtureIds: readonly string[];
  records: readonly JdEvalRecord[];
  /** The #205 semantic-vs-keyword comparison, computed for every cell whose
   *  match result reached the semantic arm. Reported only — see
   *  `compareSemanticVsKeyword`'s docblock for why this carries no CI gate. */
  comparisons: readonly SemanticVsKeywordComparison[];
}

export interface RunJdEvalInput {
  modelIds: readonly string[];
  fixtures: readonly JdEvalFixture[];
  matchFn: JdMatchFn;
  appVersion?: string | null;
  /** Clock override for deterministic timing in tests. Defaults to `Date.now`. */
  now?: () => number;
}

export async function runJdEval({
  modelIds,
  fixtures,
  matchFn,
  appVersion = null,
  now = Date.now,
}: RunJdEvalInput): Promise<JdEvalReport> {
  const records: JdEvalRecord[] = [];
  const comparisons: SemanticVsKeywordComparison[] = [];
  const startedAt = new Date(now()).toISOString();

  for (const modelId of modelIds) {
    for (const fixture of fixtures) {
      try {
        const result = await matchFn({ modelId, fixture });
        const rubric = scoreJdRubric({
          result,
          jdText: fixture.jd,
          resumeText: fixture.resume,
          gold: fixture.gold,
        });
        const injectionSafe =
          fixture.injectionPayload !== undefined && result.path === "semantic"
            ? checkNoInjectionLeak(result, fixture.injectionPayload)
            : null;
        if (result.path === "semantic") {
          comparisons.push(compareSemanticVsKeyword(fixture, result));
        }
        records.push({
          modelId,
          fixtureId: fixture.id,
          path: result.path,
          rubric,
          injectionSafe,
          error: null,
        });
      } catch (err) {
        records.push({
          modelId,
          fixtureId: fixture.id,
          path: "error",
          rubric: emptyJdRubric(),
          injectionSafe: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    startedAt,
    appVersion,
    modelIds,
    fixtureIds: fixtures.map((f) => f.id),
    records,
    comparisons,
  };
}

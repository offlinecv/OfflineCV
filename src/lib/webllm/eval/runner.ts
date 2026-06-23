// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { emptyRubricForError, scoreRubric } from "./rubric.ts";
import type {
  AggregateRow,
  EvalReport,
  RewriteFixture,
  RewriteFn,
  RunRecord,
} from "./types.ts";

/**
 * Iterate (model × variant × fixture), invoke `rewriteFn` for each cell,
 * score with the rubric, and emit a structured report.
 *
 * The runner is engine-agnostic: tests pass a stub `rewriteFn` that
 * returns canned outputs (no model, no WebGPU), and the browser entry
 * passes a real WebLLM-backed `rewriteFn`. The runner itself never
 * touches `@mlc-ai/web-llm`, so this file is safe to import in Node
 * test environments.
 *
 * Failure handling: a single failing cell logs an `error` on its
 * `RunRecord` and the iteration continues. The row scores 0 across all
 * criteria so the report shows the failure instead of silently dropping
 * the cell. That keeps a flaky model from quietly inflating an
 * aggregate by skipping its own failures.
 *
 * Sequential, not parallel — the browser entry can only host one model
 * in WebGPU at a time, and the eviction guard in `web-llm.ts` already
 * serializes cross-model loads. Running variants concurrently inside one
 * model would also race the engine cache. Sequential is the only sound
 * order.
 */

export interface RunEvalInput {
  /** Models to compare. Each one must be loadable by the `rewriteFn`. */
  modelIds: readonly string[];
  /** Prompt variants to compare. */
  variantIds: readonly string[];
  /** Fixtures to evaluate. */
  fixtures: readonly RewriteFixture[];
  /** Inference seam — stub in tests, real-engine in the browser. */
  rewriteFn: RewriteFn;
  /**
   * Optional cell-level progress callback. The browser entry uses this
   * to update the page UI; tests pass nothing.
   */
  onProgress?: (
    completed: number,
    total: number,
    cell: { modelId: string; variantId: string; fixtureId: string },
  ) => void;
  /**
   * Set when the LLM-judge flag is on. The flag itself doesn't compute
   * the judge here — the rubric's `judgeCoherence` slot stays `null`
   * unless a future patch fills it in — but it's threaded through so the
   * report can label which runs were judge-enabled.
   */
  judgeEnabled?: boolean;
  /**
   * Resumelint commit SHA the eval ran against, surfaced in the report.
   * The browser entry passes `__APP_VERSION__`; tests pass `null`.
   */
  appVersion?: string | null;
  /**
   * Clock override for deterministic timing in tests. Defaults to
   * `Date.now`. Tests pass a step-by-step ticker so duration assertions
   * stay stable.
   */
  now?: () => number;
}

export async function runEval({
  modelIds,
  variantIds,
  fixtures,
  rewriteFn,
  onProgress,
  judgeEnabled = false,
  appVersion = null,
  now = Date.now,
}: RunEvalInput): Promise<EvalReport> {
  const records: RunRecord[] = [];
  const total = modelIds.length * variantIds.length * fixtures.length;
  let completed = 0;
  const startedAt = new Date(now()).toISOString();

  for (const modelId of modelIds) {
    for (const variantId of variantIds) {
      for (const fixture of fixtures) {
        const cellStart = now();
        let record: RunRecord;
        try {
          const output = await rewriteFn({ modelId, variantId, fixture });
          const rubric = scoreRubric({
            input: fixture.bullets,
            output,
            fixtureKind: fixture.kind,
          });
          record = {
            modelId,
            variantId,
            fixtureId: fixture.id,
            fixtureKind: fixture.kind,
            inputBulletCount: fixture.bullets.length,
            outputBulletCount: output.bullets.length,
            rubric,
            rewriteDurationMs: now() - cellStart,
            error: null,
          };
        } catch (err) {
          record = {
            modelId,
            variantId,
            fixtureId: fixture.id,
            fixtureKind: fixture.kind,
            inputBulletCount: fixture.bullets.length,
            outputBulletCount: 0,
            rubric: emptyRubricForError(),
            rewriteDurationMs: now() - cellStart,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        records.push(record);
        completed += 1;
        onProgress?.(completed, total, {
          modelId,
          variantId,
          fixtureId: fixture.id,
        });
      }
    }
  }

  return {
    startedAt,
    appVersion,
    modelIds,
    variantIds,
    fixtureIds: fixtures.map((f) => f.id),
    judgeEnabled,
    records,
    aggregates: aggregateRecords(records, modelIds, variantIds),
  };
}

/**
 * Per-(model, variant) aggregate. The dedup rate is computed over
 * `redundant` fixtures only — if the set has none, the slot is `null`
 * and the report renders `—`. The composite `aggregateScore` is the
 * equal-weight mean of the deterministic rates (judge excluded) so
 * choosing a default-model from the report is one column.
 */
function aggregateRecords(
  records: readonly RunRecord[],
  modelIds: readonly string[],
  variantIds: readonly string[],
): AggregateRow[] {
  const rows: AggregateRow[] = [];
  for (const modelId of modelIds) {
    for (const variantId of variantIds) {
      const cell = records.filter(
        (r) => r.modelId === modelId && r.variantId === variantId,
      );
      const scored = cell.filter((r) => r.error === null);

      const numbersPreservedRate = rate(scored, (r) => r.rubric.numbersPreserved);
      const oneLineRate = rate(scored, (r) => r.rubric.oneLinePerBullet);
      const actionVerbRate = rate(scored, (r) => r.rubric.actionVerbLead);
      const lengthSanityRate = rate(scored, (r) => r.rubric.lengthSanity);
      const noPreambleLeakRate = rate(scored, (r) => r.rubric.noPreambleLeak);

      const redundantCell = scored.filter((r) => r.fixtureKind === "redundant");
      const dedupEffectiveRate =
        redundantCell.length === 0
          ? null
          : redundantCell.filter((r) => r.rubric.dedupEffective === true).length /
            redundantCell.length;

      const judgeScores = scored
        .map((r) => r.rubric.judgeCoherence)
        .filter((v): v is number => v !== null);
      const judgeMean =
        judgeScores.length === 0
          ? null
          : judgeScores.reduce((s, v) => s + v, 0) / judgeScores.length;

      const deterministicRates = [
        numbersPreservedRate,
        oneLineRate,
        actionVerbRate,
        lengthSanityRate,
        noPreambleLeakRate,
        ...(dedupEffectiveRate === null ? [] : [dedupEffectiveRate]),
      ];
      const aggregateScore =
        deterministicRates.reduce((s, v) => s + v, 0) / deterministicRates.length;

      rows.push({
        modelId,
        variantId,
        scoredFixtures: scored.length,
        numbersPreservedRate,
        oneLineRate,
        actionVerbRate,
        lengthSanityRate,
        noPreambleLeakRate,
        dedupEffectiveRate,
        judgeMean,
        aggregateScore,
      });
    }
  }
  return rows;
}

function rate(records: readonly RunRecord[], pred: (r: RunRecord) => boolean): number {
  if (records.length === 0) return 0;
  return records.filter(pred).length / records.length;
}

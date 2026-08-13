// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * run-llm-match.ts — semantic JD-match orchestrator + path selection (#202).
 *
 * Chains the two LLM calls behind the stable `JdMatchResult` API:
 * `loadEngine` → `extractRequirements` (#200) → `judgeEvidence` (#201) →
 * `{ path: "semantic", verdicts, summary }`.
 *
 * Fallback discipline: ANY failure resolves to the deterministic keyword path
 * (`{ path: "keyword" }`) — never a rejection, never a blank panel. That covers
 * an engine load error (which is also how a missing-WebGPU environment
 * manifests if the caller's `detectWebGpu` gate was stale), a requirement-
 * extraction hard failure (`RequirementExtractionError`), and any unexpected
 * inference error. A valid-but-EMPTY extraction also degrades: it is not a
 * failure per #200's contract, but zero verdicts would render an empty
 * semantic panel, and the keyword path always has something to show.
 * `judgeEvidence` never throws by contract — its failure mode is per-batch
 * `missing` verdicts, which stay on the semantic path by design.
 *
 * Caller contract: the `detectWebGpu` gate and the ConsentDialog gate for
 * restricted models run BEFORE this is called — this module never prompts.
 * `modelId` is the `useModelSelection` selected id; it is threaded both to
 * `loadEngine` and to `judgeEvidence`'s inference guard. `onProgress` receives
 * the engine download/load progress (first call on a cold cache is a large
 * weight fetch).
 *
 * Chunk discipline: this module transitively imports `web-llm.ts` (via
 * `judge-evidence.ts`), so it is NOT exported from the `jd-match` barrel
 * (`index.ts`), which the JD-fit entry imports statically. Consumers
 * dynamic-import this module (the cascade-tier pattern) so WebLLM stays out
 * of the entry chunk until the user opts into the semantic match.
 */

import type { HeuristicParsedResume } from "../../heuristics/types.ts";
import type { ProgressUpdate } from "../../webllm/types.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../../webllm/web-llm.ts";
import { extractJdTerms } from "../extract-jd-terms.ts";
import { computeCoverage } from "../coverage.ts";
import type { JdMatchResult, SemanticMatchSummary } from "../types.ts";
import { isAbortError } from "./abort.ts";
import { extractRequirements } from "./extract-requirements.ts";
import type { RequirementVerdict } from "./judge-evidence.ts";
import { judgeEvidence } from "./judge-evidence.ts";

/**
 * Run the semantic JD-match, degrading to the keyword path on any failure.
 *
 * Never rejects: the promise always resolves to a usable `JdMatchResult`.
 *
 * `onInferenceStart` (optional) fires exactly once, after `loadEngine`
 * resolves and BEFORE `extractRequirements` runs. It lets a state-machine
 * consumer distinguish the "engine downloading/loading" phase from the
 * "engine loaded, model is thinking" phase — the two show different UI
 * (download progress vs. a running indicator). Never fires on the fallback
 * branch (an engine-load failure): the caller stays in `loading` and then
 * transitions straight to the fallback `ready`. Kept optional so existing
 * callers that don't need the distinction are unchanged.
 *
 * `signal` (optional, #803) — abort the semantic pipeline at the next safe
 * boundary. Aborts resolve to the keyword fallback WITHOUT logging (expected
 * control flow, not an error), so a superseded run that returns is
 * indistinguishable at the caller from a run that never started. See below
 * for the boundary map. Not passed to `loadEngine` because that call is
 * cross-consumer shared (the `pendingByModelId` fast path returns the same
 * promise to every caller for the model); cancelling it would abort a load
 * another consumer is still waiting on. Bounded work per abandoned run is
 * therefore: at most one in-flight `loadEngine` await + at most one
 * currently-in-flight completion (extract OR judge batch), then bail.
 *
 * Cancellation boundaries in order:
 *   1. Pre-acquire (already-aborted at call time): skip everything, no
 *      acquire, no engine touch.
 *   2. Post-loadEngine: engine loaded but we bail before firing
 *      `onInferenceStart` or starting extract.
 *   3. Inside `extractRequirements` (pre-call): don't hit the model.
 *   4. Inside `extractRequirements` (post-call): don't run the coercion pass.
 *      Propagates as AbortError — the catch here maps it to keyword.
 *   5. Post-extract in this orchestrator: don't even reach judge.
 *   6. Inside `judgeEvidence` (per-batch): don't schedule the next batch.
 *   7. Post-judge: even if judgeEvidence returned a partial reconciled result,
 *      discard it and go to keyword.
 *
 * ## Why the whole body is bracketed by `acquireInference` (#148)
 *
 * `web-llm.ts` requires inference callers to acquire BEFORE awaiting
 * `loadEngine`, not after: `await` yields to the microtask queue even on the
 * already-loaded fast path, and a concurrent cross-model load's
 * `evictAllExcept` can see `inflightInferenceCount === 0` in that gap and
 * `.unload()` the engine out from under us. `judgeEvidence` acquires per
 * batch, but that is explicitly "defensive belt" — it does not cover
 * `loadEngine` or `extractRequirements`, which this bracket is what guards.
 *
 * The pre-acquire abort short-circuit is EXPLICITLY paired: if we bail before
 * `acquireInference`, we must also bail before the `finally`'s
 * `releaseInference`. Structurally guaranteed because the early return is
 * outside the try/finally.
 *
 * The live path this closes: `job-search/sector.ts` classifies on
 * `DEFAULT_MODEL_ID` on the same `/jobs/` page. If the user's persisted
 * `selectedModelId` differs, that classify reaches
 * `evictAllExcept(DEFAULT_MODEL_ID)` and would tear down our engine mid
 * `extractRequirements` — surfacing as a silent degrade to keyword. The
 * counter is re-entrant, so `judgeEvidence`'s inner acquire still nests
 * correctly underneath this one.
 */
export async function runLlmMatch(
  jdText: string,
  parsed: HeuristicParsedResume,
  modelId: string,
  onProgress: (update: ProgressUpdate) => void,
  onInferenceStart?: () => void,
  signal?: AbortSignal,
): Promise<JdMatchResult> {
  // Boundary 1: already-aborted at call time. No acquire, no engine touch —
  // and no release, because we didn't acquire. Placement OUTSIDE the try
  // block is what makes the acquire/release balance structural.
  if (signal?.aborted) {
    return keywordMatch(jdText, parsed);
  }

  acquireInference(modelId);
  try {
    const engine = await loadEngine(modelId, onProgress);
    // Boundary 2: aborted while loadEngine was awaiting. Bail before firing
    // `onInferenceStart` — otherwise a state-machine consumer would flash a
    // "running" indicator for a run that never actually did any inference.
    if (signal?.aborted) return keywordMatch(jdText, parsed);
    // `onInferenceStart` is a notification, not orchestration — a throwing
    // consumer callback must not be misattributed as an engine failure by
    // the surrounding catch (which logs "semantic path failed" and degrades
    // to keyword). Isolate it. The only in-repo consumer is a `setState`,
    // so this is defensive belt, not a live scenario.
    try {
      onInferenceStart?.();
    } catch (err) {
      console.warn("[run-llm-match] onInferenceStart callback threw:", err);
    }
    const requirements = await extractRequirements(jdText, engine, signal);
    // Boundary 5: aborted between extract returning and judge starting.
    // (The internal boundaries 3/4 live inside `extractRequirements`.)
    if (signal?.aborted) return keywordMatch(jdText, parsed);
    if (requirements.length === 0) {
      // Legitimate empty extraction (#200: not a failure) — but a semantic
      // result with no verdicts is a blank panel, so degrade anyway.
      return keywordMatch(jdText, parsed);
    }
    const verdicts = await judgeEvidence(
      requirements,
      parsed,
      engine,
      modelId,
      signal,
    );
    // Boundary 7: `judgeEvidence` never throws, so if the signal fired
    // mid-loop it returned a partial reconciled result with abandoned
    // requirements defaulted to `missing`. Discard it in favor of keyword
    // rather than showing the user a semantic verdict list that reflects a
    // run they already superseded.
    if (signal?.aborted) return keywordMatch(jdText, parsed);
    return { path: "semantic", verdicts, summary: summarize(verdicts) };
  } catch (err) {
    if (isAbortError(err)) {
      // Cancellation is expected control flow, not a failure. Do NOT log —
      // #803's "cancellation is not logged as semantic failure" acceptance
      // criterion. The keyword fallback still runs so the caller's promise
      // resolves (per the never-rejects contract) with something renderable.
      return keywordMatch(jdText, parsed);
    }
    console.warn(
      "[run-llm-match] semantic path failed; falling back to keyword:",
      err,
    );
    return keywordMatch(jdText, parsed);
  } finally {
    // Paired with the `acquireInference` above on EVERY exit — the semantic
    // return, the empty-extraction degrade, the mid-pipeline abort returns,
    // and the catch's keyword fallback. The pre-acquire abort short-circuit
    // above lives OUTSIDE this try, so it correctly skips the release too.
    // A missed release would pin `inflightInferenceCount` above zero for the
    // page's lifetime and park every later cross-model `.unload()` forever.
    releaseInference(modelId);
  }
}

/** Tally verdict statuses once so the renderer never re-counts. */
function summarize(
  verdicts: readonly RequirementVerdict[],
): SemanticMatchSummary {
  let met = 0;
  let partial = 0;
  let missing = 0;
  for (const verdict of verdicts) {
    if (verdict.status === "met") met += 1;
    else if (verdict.status === "partial") partial += 1;
    else missing += 1;
  }
  return { met, partial, missing, total: verdicts.length };
}

/**
 * The deterministic keyword path — the exact `extractJdTerms` +
 * `computeCoverage` composition the JD-match callers run today (see
 * `PasteJdPanel` and `rank.ts`), wrapped in the keyword arm.
 */
function keywordMatch(
  jdText: string,
  parsed: HeuristicParsedResume,
): JdMatchResult {
  const extracted = extractJdTerms(jdText);
  const coverage = computeCoverage(parsed, extracted.all);
  return {
    path: "keyword",
    coverage,
    terms: extracted.all,
    nounsDropped: extracted.nounsDropped,
  };
}

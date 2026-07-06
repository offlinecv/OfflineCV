// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import { loadEngine } from "../../webllm/web-llm.ts";
import { extractJdTerms } from "../extract-jd-terms.ts";
import { computeCoverage } from "../coverage.ts";
import type { JdMatchResult, SemanticMatchSummary } from "../types.ts";
import { extractRequirements } from "./extract-requirements.ts";
import type { RequirementVerdict } from "./judge-evidence.ts";
import { judgeEvidence } from "./judge-evidence.ts";

/**
 * Run the semantic JD-match, degrading to the keyword path on any failure.
 *
 * Never rejects: the promise always resolves to a usable `JdMatchResult`.
 */
export async function runLlmMatch(
  jdText: string,
  parsed: HeuristicParsedResume,
  modelId: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<JdMatchResult> {
  try {
    const engine = await loadEngine(modelId, onProgress);
    const requirements = await extractRequirements(jdText, engine);
    if (requirements.length === 0) {
      // Legitimate empty extraction (#200: not a failure) — but a semantic
      // result with no verdicts is a blank panel, so degrade anyway.
      return keywordMatch(jdText, parsed);
    }
    const verdicts = await judgeEvidence(requirements, parsed, engine, modelId);
    return { path: "semantic", verdicts, summary: summarize(verdicts) };
  } catch (err) {
    console.warn(
      "[run-llm-match] semantic path failed; falling back to keyword:",
      err,
    );
    return keywordMatch(jdText, parsed);
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
 * `computeCoverage` composition the JD-fit surface runs today
 * (`JdFitApp.tsx`), wrapped in the keyword arm.
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

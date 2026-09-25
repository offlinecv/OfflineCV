// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useActiveResume — the one place the analyzed résumé is paired with its
 * degenerate-parse recovery pass (#243), so `App` and the #1028 repro run the
 * SAME wiring rather than two copies of it.
 *
 * `useLlmRecovery` is fed `savableResult`, not `displayResult` (#1028).
 * `displayResult` keeps the BASE parse's section pool on purpose (#445) —
 * exactly the shape `score-edited.ts` documents as the #487 mistake to grade
 * from. While no recovery is active that's harmless: `activeScore` returns
 * `score`, `useAnalyzedResume`'s own edit-folded grade, which never touches
 * `result`'s sections. But once a recovery pass lands, `activeScore` re-grades
 * via `scoreParsedResume(activeResult)`, which pools Specificity/Structure
 * straight off `result`'s sections — so a `displayResult` here froze that pool
 * at whatever it was before the first post-recovery render, and a bullet edit
 * made afterward moved the displayed fields but never the graded pool, leaving
 * the score and Fix It count stale until the résumé itself changed.
 * `savableResult` (`flattenEditedResult`) carries the edited sections
 * alongside the edited fields — the same pairing #1022 established for the
 * autosaved record — so the re-grade sees a live edit in the render it lands
 * in, recovered or not.
 *
 * A hook of its own, rather than two lines inline in `App`, because the
 * argument IS the fix: a test that re-typed the call could pass while `App`
 * reverted it. `useLlmRecovery.live-regrade.repro.test.tsx` calls this.
 */

import { useAnalyzedResume, type AnalyzedResume } from "./useAnalyzedResume.ts";
import { useLlmRecovery, type LlmRecovery } from "./useLlmRecovery.ts";

export interface ActiveResume extends AnalyzedResume {
  /** The recovered parse + score the page shows and hands on; null exactly
   *  when there is nothing parsed. */
  recovery: LlmRecovery | null;
}

export function useActiveResume(): ActiveResume {
  const analyzed = useAnalyzedResume();
  const recovery = useLlmRecovery(
    analyzed.savableResult,
    analyzed.edited?.score ?? null,
    analyzed.parseKey,
  );
  return { ...analyzed, recovery };
}

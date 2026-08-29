// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useLlmRecovery — ownership of the degenerate-parse recovery result (#243),
 * lifted out of `ParsedCard` by #823.
 *
 * `useLlmEscapeHatch` runs the pass; this owns what the pass PRODUCED. The two
 * are separate because they have different lifetimes and different owners: the
 * pass belongs to the surface showing the offer, the result belongs to whoever
 * has to hand the résumé to someone else.
 *
 * It moved up for one reason. `/` has two routes into `/jobs/` — the journey
 * rail's Match-jobs stage and the header's "Saved jobs" link — and both run in
 * `App`. While this state lived in `ParsedCard`, `App` could not see it, so a
 * user who recovered a degenerate parse with the on-device pass and then left
 * via either route shipped the PRE-recovery fields (the divergence `#812`
 * deferred and `FindJobsLauncher`'s docblock recorded). One owner above both
 * routes closes it, and closes it for any third route that appears later.
 *
 * **The override is keyed to the parse it was produced from, and that is
 * derivation, not an effect.** This state now outlives the résumé under it —
 * `App` never unmounts, where `Result` used to be discarded by the `parsing`
 * phase between two files, which is what made a bare `useState` safe before.
 * An effect that cleared it on a `parseKey` change would still render one
 * commit with the previous résumé's LLM fields merged into the new one. Storing
 * the key alongside the payload and comparing during render has no such window:
 * a stale override simply is not an override.
 */

import { useCallback, useMemo, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { scoreParsedResume } from "../lib/score/score-cascade.ts";
import { mergeLlmParse } from "../lib/webllm/merge-override.ts";
import type { LlmParsedResume } from "../lib/webllm/parse-resume.ts";

export interface LlmRecovery {
  /**
   * The parse every consumer renders, exports and hands over: the heuristic
   * result as passed in, or a synthetic merge of the LLM-parsed fields into it
   * once a recovery pass has landed for THIS résumé. `rawText` / `markdown` /
   * layout fields stay original — the override is parse-field only.
   */
  activeResult: CascadeResult;
  /** {@link activeResult}'s score — re-derived from the overridden parse when
   *  one is in force, so the score card reflects the recovered fields. */
  activeScore: AnonymousAtsScore;
  /**
   * Opaque identity of the parse behind {@link activeResult}. Changes on the
   * two, and only two, ways the résumé under a mounted surface can be replaced
   * — the pristine parse changing underneath it (a library load, which goes
   * "done" → "done" without passing through "parsing") and a recovery pass
   * swapping in an LLM re-parse.
   *
   * Deliberately NOT `activeResult`'s own identity: that is a memo over the
   * edit override maps, so every keystroke in the inline editor mints a fresh
   * object for the SAME parse. Anything keyed on it fires on edits — which is
   * why the JD-steering reset downstream takes this token instead (#576).
   */
  parseIdentity: unknown;
  /** Is a recovered parse in force? Drives the provenance badge. */
  isLlmRecovered: boolean;
  /** Handed to `LlmEscapeHatchPanel`; called once per completed pass. */
  onRecovered: (llmParsed: LlmParsedResume) => void;
}

/**
 * @param result   the edit-folded heuristic parse on screen, or null when there
 *                 is nothing parsed yet.
 * @param score    `result`'s edited score, or null on the same terms.
 * @param parseKey the pristine-parse identity behind `result` — see
 *                 `useAnalyzedResume.parseKey`. `result` changes on every
 *                 keystroke; this does not.
 * @returns null exactly when `result` or `score` is null.
 */
export function useLlmRecovery(
  result: CascadeResult | null,
  score: AnonymousAtsScore | null,
  parseKey: unknown,
): LlmRecovery | null {
  // The payload AND the résumé it was produced from. See the docblock: the
  // pairing is what makes staleness a render-time question rather than an
  // effect's race.
  const [recovered, setRecovered] = useState<{
    parseKey: unknown;
    llmParsed: LlmParsedResume;
  } | null>(null);

  const llmOverride =
    recovered !== null && recovered.parseKey === parseKey
      ? recovered.llmParsed
      : null;

  const onRecovered = useCallback(
    (llmParsed: LlmParsedResume) => {
      setRecovered({ parseKey, llmParsed });
    },
    [parseKey],
  );

  const activeResult = useMemo(
    () =>
      result === null || llmOverride === null
        ? result
        : mergeLlmParse(result, llmOverride),
    [result, llmOverride],
  );

  const parseIdentity = useMemo(
    () => ({ parseKey, llmOverride }),
    [parseKey, llmOverride],
  );

  const activeScore = useMemo(() => {
    if (llmOverride === null || activeResult === null) return score;
    return scoreParsedResume(activeResult);
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md): `activeResult` carries the merge, `llmOverride` selects the
    // branch, and `score` is the value the un-recovered branch returns.
  }, [activeResult, llmOverride, score]);

  if (activeResult === null || activeScore === null) return null;

  return {
    activeResult,
    activeScore,
    parseIdentity,
    isLlmRecovered: llmOverride !== null,
    onRecovered,
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * One-shot resume handoff from `/` (parser audit) to `/jd-fit` (issue #226).
 *
 * When a user parses a résumé on `/` and clicks "Check fit against a job", the
 * already-parsed + edited result is stashed here so `/jd-fit` can rehydrate it
 * without re-parsing the PDF. We hand off the PARSED JSON (the edited
 * CascadeResult shape `<Result>` receives, plus its re-graded score), not the
 * PDF bytes — JD-fit doesn't show the source-PDF pane, and JSON survives the
 * navigation cheaply. PDF bytes are intentionally dropped (they don't serialize
 * to JSON and the source-PDF pane isn't shown on /jd-fit).
 *
 * Stored under sessionStorage (not localStorage) because this is a
 * within-session, within-tab handoff — it must not leak a parsed résumé into a
 * later, unrelated session. Consumed once: `/jd-fit` reads then clears the key
 * on mount, so a manual reload falls back to its own DropZone.
 *
 * Key follows the repo's `rl_*` storage convention.
 */

import type { CascadeResult } from "./heuristics/types.ts";
import type { AnonymousAtsScore } from "./score/score.ts";

/** sessionStorage key for the parser-audit → JD-fit handoff payload (#226). */
export const JDFIT_HANDOFF_KEY = "rl_jdfit_handoff";

export interface JdFitHandoff {
  /** The edited CascadeResult `<Result>` receives ({ ...result, parsed }). */
  result: CascadeResult;
  /** The re-graded anonymous ATS score for that edited result. */
  score: AnonymousAtsScore;
}

/** Write the one-shot handoff payload before navigating to /jd-fit. */
export function writeJdFitHandoff(payload: JdFitHandoff): void {
  try {
    sessionStorage.setItem(JDFIT_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private-mode / disabled storage — navigation still proceeds and
    // /jd-fit falls back to its own DropZone.
  }
}

/**
 * Read AND clear the handoff payload (one-shot). Returns null when absent or
 * malformed so the caller falls back to its own DropZone.
 */
export function consumeJdFitHandoff(): JdFitHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(JDFIT_HANDOFF_KEY);
    if (raw !== null) sessionStorage.removeItem(JDFIT_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as JdFitHandoff;
    // Minimal shape guard: a malformed/partial payload falls back to DropZone.
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.result || !parsed.result.canonical || !parsed.score) return null;
    return parsed;
  } catch {
    return null;
  }
}

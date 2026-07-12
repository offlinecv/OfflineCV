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

/**
 * Sentinel wrapper for a `Map` in the JSON payload (#450). `JSON.stringify`
 * turns a `Map` into `{}` (its own enumerable props, of which a Map has none),
 * silently dropping every entry — so `result.canonical.sections.byName` and
 * `.sectionHeadings` would revive as empty `{}` and the scorer's
 * `sections.byName.get(...)` would throw on `/jd-fit`. We tag Maps on write and
 * rebuild them on read. Structural (not path-based) so it survives further
 * canonical-shape churn (#441): any `Map` anywhere in the payload round-trips.
 */
interface SerializedMap {
  readonly __rlMap: readonly [unknown, unknown][];
}

function replaceMaps(_key: string, value: unknown): unknown {
  return value instanceof Map
    ? ({ __rlMap: [...value.entries()] } satisfies SerializedMap)
    : value;
}

function reviveMaps(_key: string, value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    Array.isArray((value as SerializedMap).__rlMap)
    ? new Map((value as SerializedMap).__rlMap)
    : value;
}

export interface JdFitHandoff {
  /** The edited CascadeResult `<Result>` receives ({ ...result, parsed }). */
  result: CascadeResult;
  /** The re-graded anonymous ATS score for that edited result. */
  score: AnonymousAtsScore;
}

/** Write the one-shot handoff payload before navigating to /jd-fit. */
export function writeJdFitHandoff(payload: JdFitHandoff): void {
  try {
    sessionStorage.setItem(
      JDFIT_HANDOFF_KEY,
      JSON.stringify(payload, replaceMaps),
    );
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
    const parsed = JSON.parse(raw, reviveMaps) as JdFitHandoff;
    // Minimal shape guard: a malformed/partial payload falls back to DropZone.
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.result || !parsed.result.canonical || !parsed.score) return null;
    // The scorer/section reads require a revived `byName` Map, not a plain
    // object (#450). Reject a payload where it failed to round-trip as a Map.
    if (!(parsed.result.canonical.sections?.byName instanceof Map)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * One-shot resume handoff from `/` (parser audit) to `/jd-fit` (issue #226).
 *
 * When a user parses a résumé on `/` and clicks "Check fit against a job", the
 * parse is stashed here so `/jd-fit` can rehydrate it without re-parsing the
 * PDF. We hand off the PARSED JSON, not the PDF bytes — JD-fit doesn't show the
 * source-PDF pane, and JSON survives the navigation cheaply.
 *
 * What crosses is the PRISTINE parse + score and the user's EDIT STATE as a
 * separate `edit` snapshot (#456) — never the override-APPLIED result. `/jd-fit`
 * runs its own edit layer, so it must receive the same two inputs `/` had and
 * re-apply them itself. Handing over an applied result instead made the edits
 * unrecoverable on the far side: they had already been baked into the fields, so
 * `/jd-fit` could not tell a user-ADDED entry from a parsed one (it lost its
 * Remove button) and its fresh, empty edit layer re-derived achievement fields
 * from the applied ones. Re-seeding the far side from an applied payload is NOT
 * a fix — the entries would be appended a second time.
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
import type { EditSnapshot } from "../hooks/useEditableParse.ts";

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
 *
 * `__rlMap` is a RESERVED key in this handoff payload (#452 review): `reviveMaps`
 * rebuilds any object with an array-valued `__rlMap` prop into a `Map`, so no
 * résumé field may carry a literal `__rlMap` array of its own — it would be
 * silently coerced to a `Map` on read. No canonical field has that shape today.
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
  /** The PRISTINE CascadeResult — the parse as it came off the cascade, with NO
   *  overrides applied. `/jd-fit` folds `edit` onto this itself. */
  result: CascadeResult;
  /** The PRISTINE anonymous ATS score for that parse. Its `bullets` pool is the
   *  one `edit.bulletOverrides` / `removedBullets` are keyed against, so it must
   *  be the un-edited pool, not a re-graded one. */
  score: AnonymousAtsScore;
  /** The user's edit state from `/`, replayed into `/jd-fit`'s own edit layer so
   *  their corrections carry over AND stay editable (an added entry is still an
   *  added entry). Absent/empty when they made no edits. */
  edit: EditSnapshot;
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
    if (!parsed.edit) return null;
    // The scorer/section reads require a revived `byName` Map, not a plain
    // object (#450). Reject a payload where it failed to round-trip as a Map.
    if (!(parsed.result.canonical.sections?.byName instanceof Map)) return null;
    return parsed;
  } catch {
    return null;
  }
}

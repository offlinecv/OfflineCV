// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * One-shot JD-context handoff from `/jobs/` back to `/` (issue #576).
 *
 * The Find-Jobs surface (`/jobs/`) is a separate HTML entry, so a user
 * clicking "Tailor résumé to this job" on a `JobResultCard` — or on the
 * paste-a-JD disclosure below the results — is not on the same page as the
 * rewrite engine (which lives on `/` inside `ReconstructedResume` → the
 * whole-résumé rewrite hook). This module lets `/jobs/` stash the JD-driven
 * rewrite instruction (`buildJdRewriteContext`'s output) in sessionStorage,
 * navigate back to `/`, and have `ResultDetailTabs` consume it on mount:
 * set `jdContext` and switch to the Reconstructed tab.
 *
 * Consumed ONCE — a manual reload of `/` falls back to the plain rewrite
 * prompt rather than silently keeping steering toward a JD from a different
 * session. Also mirrors `nav-return.ts`'s pair: the read and the clear
 * happen together because the leg-owner is the ONLY surface that must
 * absorb it — a later, unrelated visit's ResultDetailTabs must find nothing.
 *
 * Key follows the repo's `ocv_*` sessionStorage convention.
 */

export const TAILOR_HANDOFF_KEY = "ocv_tailor_handoff";

export interface TailorHandoff {
  /** The steering instruction the rewrite engine folds into
   *  `RewriteSteering.userInstructions` — see `buildJdRewriteContext`. */
  jdContext: string;
}

/** Write the handoff payload before navigating back to `/`. */
export function writeTailorHandoff(payload: TailorHandoff): void {
  try {
    sessionStorage.setItem(TAILOR_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private-mode / disabled storage — navigation still proceeds and
    // `/`'s rewrite defaults to its generic (non-JD-steered) prompt.
  }
}

/**
 * Read AND clear the handoff payload (one-shot). Returns null when absent or
 * malformed so the caller falls back to a generic rewrite.
 */
export function consumeTailorHandoff(): TailorHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(TAILOR_HANDOFF_KEY);
    if (raw !== null) sessionStorage.removeItem(TAILOR_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as TailorHandoff;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.jdContext !== "string" || parsed.jdContext.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

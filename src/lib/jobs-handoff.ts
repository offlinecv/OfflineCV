// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Résumé handoff from `/` (parser audit) to `/jobs/` (the job-search workbench).
 *
 * `/` no longer hosts the search itself — its Find Jobs tab is a launcher that
 * stashes the EDITED parsed résumé here and navigates. `/jobs/` seeds its query
 * from that parse (`buildJobQuery`) and ranks postings against it.
 *
 * What crosses is ONLY `HeuristicParsedResume` — no PDF bytes, no raw text, no
 * `CascadeResult`. That is the whole input the job-search lane consumes
 * (`FindJobsPanel` already took exactly this prop), so widening the payload
 * would hand `/jobs/` data it has no use for. Unlike the JD-fit handoff there
 * is no edit-layer replay to arrange: `/jobs/` runs no edit layer at all, so the
 * APPLIED parse is the correct thing to send — the user's corrections are what
 * they want searched against.
 *
 * `sessionStorage`, per the repo's `ocv_*` convention, so the parse dies with
 * the tab and cannot leak into a later, unrelated session.
 *
 * Deliberately NOT one-shot: `/jobs/` has no DropZone to fall back to, so
 * consuming the key would turn an ordinary browser reload (or a Back into
 * the results page) into a dead end with no way to recover but returning to
 * `/`. The key is overwritten on each launch, so a newer parse always wins,
 * and it dies with the tab either way.
 */

import type { HeuristicParsedResume } from "./heuristics/types.ts";

/** sessionStorage key for the parser-audit → job-search handoff payload. */
export const JOBS_HANDOFF_KEY = "ocv_jobs_handoff";

export interface JobsHandoff {
  /** The EDITED parsed résumé — `buildJobQuery` seeds the query from its titles
   *  and skills, and the fit ranking reads its fuller shape (summary,
   *  education). */
  parsed: HeuristicParsedResume;
}

/** Write the handoff payload before navigating to /jobs/. */
export function writeJobsHandoff(payload: JobsHandoff): void {
  try {
    sessionStorage.setItem(JOBS_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private-mode / disabled storage — the navigation still proceeds
    // and /jobs/ renders its "no résumé yet" state pointing back at `/`.
  }
}

/**
 * Drop the handoff payload.
 *
 * The counterpart to the "not one-shot" rule above: because a read never
 * clears, a payload from an earlier launch survives until something overwrites
 * it — and a route that leaves `/` with NO parse (the header link before a
 * parse, or after the user reset one) would otherwise hand `/jobs/` a résumé
 * the user has already discarded, silently ranking against it and suppressing
 * the "open this workbench from your resume" hint that is the correct empty
 * state. Departing with nothing must therefore say so, not stay silent.
 */
export function clearJobsHandoff(): void {
  try {
    sessionStorage.removeItem(JOBS_HANDOFF_KEY);
  } catch {
    // Inaccessible storage — nothing was readable either, so `/jobs/` already
    // renders its empty state.
  }
}

/**
 * Read the handoff payload. Returns null when absent or malformed so `/jobs/`
 * falls back to its empty state instead of rendering a broken query.
 *
 * Non-destructive: see the module docblock for why this does not clear the key.
 */
export function readJobsHandoff(): JobsHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(JOBS_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const payload = JSON.parse(raw) as JobsHandoff;
    if (!payload || typeof payload !== "object") return null;
    const { parsed } = payload;
    if (!parsed || typeof parsed !== "object") return null;
    // `HeuristicParsedResume` guarantees these three as arrays (empty when the
    // parse found nothing). A payload missing them is not a parse we can rank.
    if (
      !Array.isArray(parsed.skills) ||
      !Array.isArray(parsed.experience) ||
      !Array.isArray(parsed.education)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

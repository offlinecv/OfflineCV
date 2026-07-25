// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Weak-match display threshold (issue 567) — the ONE place the "is this posting
 * weak" cutoff lives. Reads #561's `RankedJob.rating.overall` (the 0–5 star
 * rating shown on the card — see `rank.ts`/`rating.ts`); this module never
 * computes a second fit number, it only names a cut point on the existing one.
 *
 * Keyed on the STAR rating, not raw coverage: the star is what the user sees on
 * the card, so the fold must agree with it — a posting shown at 3★ must never be
 * hidden in "weak matches" because some invisible raw-coverage number was low.
 *
 * A posting whose overall rating falls below this constant is collapsed into the
 * "weak matches" disclosure (`WeakMatchesSection.tsx`) beneath the strong
 * results instead of interleaved with them — never hard-dropped, always
 * reachable by expanding (the #545/epic never-hard-drop precedent).
 *
 * Deliberately a fixed named constant, not a derived/adaptive one — the issue
 * calls for a simple, legible cut, and `WEAK_MATCH_LABEL` derives its text from
 * this value so the section header can never drift out of sync with the cutoff.
 */
const WEAK_MATCH_STAR_THRESHOLD = 2.5;

/** "below 2.5★ match" — always in sync with `WEAK_MATCH_STAR_THRESHOLD`. */
export const WEAK_MATCH_LABEL = `below ${WEAK_MATCH_STAR_THRESHOLD}★ match`;

/** True when a ranked posting's overall star rating is below the weak cutoff —
 *  the single predicate `JobSearchResults` splits the capped list on. */
export function isWeakMatch(rating: { overall: number }): boolean {
  return rating.overall < WEAK_MATCH_STAR_THRESHOLD;
}

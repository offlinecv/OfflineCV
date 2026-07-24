// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The single ordered seniority ladder (#562). One scale, not two — IC and
 * management rungs are interleaved so any two levels are comparable by a plain
 * rung distance, which is what lets the ranker apply a *soft* level-mismatch
 * penalty (a Director query sinks a Junior posting, not "incomparable").
 *
 * The labels here are exactly the labels `SENIORITY_PATTERNS`
 * (`query-builder.ts`) can emit — this module owns no taxonomy of its own, it
 * only ORDERS the labels that table already produces (the #562 contract: reuse
 * the existing table, add a level axis, invent no new vocabulary). `parseSeniority
 * Label` turns a title into one of these labels; this ladder turns a label into
 * a comparable rung.
 *
 * Rung assignment (resolved in the issue before impl):
 *
 *   IC:   Intern < Junior < Mid < Senior < (Lead) < Staff < Principal
 *   Mgmt: Manager ≈ Staff+1, Director ≈ Principal+1, VP > Director, Exec > VP
 *
 * Consequences this is chosen to give, all deliberate:
 *   - A Staff query reads a Manager posting as ~1 rung away (5 vs 6) — a strong
 *     Manager fit sinks slightly, never vanishes.
 *   - A Director query reads a Junior IC posting as many rungs away (7 vs 1) —
 *     heavily demoted — but an adjacent-tier Manager posting as ~1 rung.
 *   - `Mid` is in the ladder for completeness (it's the conceptual rung between
 *     Junior and Senior); the current pattern table never emits it, so it's
 *     documentation of the intended order, not a live entry.
 *   - `Lead` ("Tech Lead"/"Team Lead") sits between Senior and Staff — above a
 *     plain Senior, below Staff — the table's own IC ordering.
 *
 * Absolute values are meaningless; only DIFFERENCES are used. Tuning the
 * offsets (if a fixture argues Manager/Director sit wrong) is a data change
 * here — the single-ladder shape is the decision, not these integers.
 *
 * Reused downstream: #565 (optional seniority term in the title-side score) and
 * #568 (the target-level refinement control) read `seniorityRung` /
 * `seniorityRungDistance` rather than re-deriving an order.
 */

/** Label → position on the single ordered ladder. Higher = more senior. */
export const SENIORITY_LADDER: Readonly<Record<string, number>> = {
  Intern: 0,
  Junior: 1,
  Mid: 2,
  Senior: 3,
  Lead: 4,
  Staff: 5,
  Principal: 6,
  Manager: 6, // Staff + 1
  Director: 7, // Principal + 1
  VP: 8, // > Director
  Executive: 9, // > VP
};

/**
 * The ladder position of a seniority `label`, or `undefined` when the label is
 * absent or not a recognized rung. `undefined` is the neutral case the ranker
 * reads as "no level signal" (no penalty) — never as "lowest rung".
 */
export function seniorityRung(label: string | undefined): number | undefined {
  if (!label) return undefined;
  return SENIORITY_LADDER[label];
}

/**
 * Rung distance between two seniority labels, or `undefined` when EITHER side
 * carries no recognizable level. Callers treat `undefined` as neutral (skip the
 * penalty) — a posting whose title has no parseable level, or a query with no
 * derived seniority, must not be penalized as if it were the bottom rung. The
 * distance is symmetric and always ≥ 0.
 */
export function seniorityRungDistance(
  a: string | undefined,
  b: string | undefined,
): number | undefined {
  const ra = seniorityRung(a);
  const rb = seniorityRung(b);
  if (ra === undefined || rb === undefined) return undefined;
  return Math.abs(ra - rb);
}

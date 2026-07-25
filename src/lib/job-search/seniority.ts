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

const SENIORITY_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Leadership/exec tier (#540) — most specific/senior first.
  { label: "Executive", pattern: /\bco-?founder\b|\bfounder\b/i },
  { label: "Executive", pattern: /\bchief\s+.+?\s+officer\b/i },
  { label: "Executive", pattern: /\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcio\b|\bcmo\b|\bciso\b|\bcxo\b/i },
  { label: "VP", pattern: /\bsvp\b|\bsenior\s+vice\s+president\b/i },
  { label: "VP", pattern: /\bevp\b|\bexecutive\s+vice\s+president\b/i },
  { label: "VP", pattern: /\bvp\b|\bvice\s+president\b/i },
  { label: "Director", pattern: /\bdirector\b|\bhead\s+of\b/i },
  { label: "Manager", pattern: /\bmanager\b/i },
  // "Chief of Staff" is an exec/leadership role, not the IC "Staff" rung — it
  // lacks the trailing "officer" the generic Chief row requires, so it must be
  // caught explicitly ABOVE the IC ladder or it falls through to `\bstaff\b`.
  { label: "Executive", pattern: /\bchief\s+of\s+staff\b/i },
  // IC ladder (original #539 table) — specific before general.
  { label: "Staff", pattern: /\bstaff\b/i },
  { label: "Principal", pattern: /\bprincipal\b/i },
  { label: "Lead", pattern: /\blead\b/i },
  { label: "Senior", pattern: /\bsenior\b|\bsr\.?\b/i },
  { label: "Junior", pattern: /\bjunior\b|\bjr\.?\b/i },
  { label: "Intern", pattern: /\bintern(?:ship)?\b/i },
];

/**
 * Parse a single seniority label out of one title by walking `SENIORITY_PATTERNS`
 * top-to-bottom (first match wins — see that table's ordering notes). Returns
 * `undefined` when the title carries no recognized level keyword.
 *
 * Exported (#562) so the ranker can parse a level out of a *posting* title with
 * the exact same table the query derivation uses — no second taxonomy. Also the
 * fn #565/#568 reuse for their own title-side level reads.
 */
export function parseSeniorityLabel(title: string): string | undefined {
  for (const { label, pattern } of SENIORITY_PATTERNS) {
    if (pattern.test(title)) return label;
  }
  return undefined;
}

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


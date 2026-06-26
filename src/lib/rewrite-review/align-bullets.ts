// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * align-bullets.ts — greedily align a rewrite's proposed bullets to the
 * originals so each proposed bullet can render as an inline diff against its
 * nearest original and be accepted/rejected individually (issue #211).
 *
 * The WebLLM rewrite emits a *new* bullet list (M may ≠ N original) — it can
 * merge, drop, reorder, or add bullets — so there is no inherent 1:1 mapping.
 * We recover one with an order-preserving sequence alignment (Needleman–Wunsch
 * over a word-level similarity score, gated by a threshold): a monotonic
 * matching that maximises total similarity. The result is a flat, in-order list
 * of pairs:
 *
 *   - `matched`  — a proposed bullet aligned to an original (its inline diff).
 *   - `added`    — a proposed bullet with no original (a pure insertion).
 *   - `removed`  — an original bullet with no proposed (a pure deletion).
 *
 * Why order-preserving (not nearest-neighbour greedy): a per-proposed
 * "find the best original anywhere" greedy mis-pairs reordered or
 * duplicate-text bullets, and can map two proposed bullets onto the same
 * original. A monotonic DP consumes each bullet exactly once and keeps the
 * diff readable top-to-bottom.
 *
 * Pure and deterministic: same inputs → same pairs, no I/O, no clock/random.
 */

/** One aligned unit in the review list. Exactly one of the three kinds. */
export type AlignedPair =
  | {
      kind: "matched";
      /** Stable id for the decision/edit maps — unique within one alignment. */
      id: string;
      original: string;
      /** Index of the original bullet in the input `original[]`. */
      originalIndex: number;
      proposed: string;
      /** Index of the proposed bullet in the input `proposed[]`. */
      proposedIndex: number;
    }
  | {
      kind: "added";
      id: string;
      proposed: string;
      proposedIndex: number;
    }
  | {
      kind: "removed";
      id: string;
      original: string;
      originalIndex: number;
    };

/**
 * Minimum word-level similarity for two bullets to be considered "the same
 * bullet, reworded" rather than an unrelated add+remove. Tuned so a typical
 * tightening edit (verb swap, metric added, trailing clause trimmed) still
 * pairs, while two genuinely different bullets fall to add/remove. A matched
 * pair below this never forms — the DP prefers the two gaps.
 */
export const MATCH_THRESHOLD = 0.3;

/** Lowercase + collapse whitespace; the normaliser both similarity and the
 *  word split run on, so casing/spacing never changes a score. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word multiset for `text`, after stripping a leading bullet marker so a
 *  "• "-prefixed line scores the same as its bare form. */
function words(text: string): string[] {
  const stripped = normalize(text).replace(/^[-*•●–▪◦‣▶►·]+\s*/, "");
  if (!stripped) return [];
  return stripped.split(" ").filter((w) => w.length > 0);
}

/**
 * Word-level Sørensen–Dice similarity in [0, 1] over the two bullets' word
 * MULTISETS — so repeated words count by their min occurrence, not collapsed
 * to a set (which would over-score boilerplate-heavy bullets). Two empty
 * bullets are defined as identical (1); one empty is 0.
 */
export function bulletSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;

  const countsA = new Map<string, number>();
  for (const w of wa) countsA.set(w, (countsA.get(w) ?? 0) + 1);

  let overlap = 0;
  const remaining = new Map(countsA);
  for (const w of wb) {
    const c = remaining.get(w);
    if (c !== undefined && c > 0) {
      overlap += 1;
      remaining.set(w, c - 1);
    }
  }

  return (2 * overlap) / (wa.length + wb.length);
}

/**
 * Align `proposed` to `original`, returning an in-order list of pairs.
 *
 * Algorithm: Needleman–Wunsch with
 *   - match score = `bulletSimilarity` when it clears {@link MATCH_THRESHOLD},
 *     else `-Infinity` (a sub-threshold cell can never be chosen as a match —
 *     the DP routes through the two gap moves instead);
 *   - gap score = 0 (an add or a remove neither helps nor hurts the total).
 * Backtracking from the bottom-right corner yields the pairs in reading order;
 * ties favour `matched` over the gaps, then `removed` (original) before
 * `added` (proposed) so the diff reads original-then-new at a divergence.
 *
 * Edge cases:
 *   - empty `original`  → every proposed is `added`, in order.
 *   - empty `proposed`  → every original is `removed`, in order.
 *   - both empty        → `[]`.
 */
export function alignBullets(
  original: readonly string[],
  proposed: readonly string[],
): AlignedPair[] {
  const n = original.length;
  const m = proposed.length;

  if (n === 0) {
    return proposed.map((p, j) => ({
      kind: "added" as const,
      id: `add:${j}`,
      proposed: p,
      proposedIndex: j,
    }));
  }
  if (m === 0) {
    return original.map((o, i) => ({
      kind: "removed" as const,
      id: `del:${i}`,
      original: o,
      originalIndex: i,
    }));
  }

  // Precompute the gated match scores once (O(n·m) similarity calls).
  const sim: number[][] = Array.from({ length: n }, () =>
    new Array<number>(m).fill(0),
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const s = bulletSimilarity(original[i]!, proposed[j]!);
      sim[i]![j] = s >= MATCH_THRESHOLD ? s : Number.NEGATIVE_INFINITY;
    }
  }

  // dp[i][j] = best total score aligning original[0..i) with proposed[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) dp[i]![0] = 0; // leading removals: gap = 0
  for (let j = 1; j <= m; j++) dp[0]![j] = 0; // leading additions: gap = 0

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchScore = sim[i - 1]![j - 1]!;
      const diag =
        matchScore === Number.NEGATIVE_INFINITY
          ? Number.NEGATIVE_INFINITY
          : dp[i - 1]![j - 1]! + matchScore;
      const up = dp[i - 1]![j]!; // original[i-1] removed
      const left = dp[i]![j - 1]!; // proposed[j-1] added
      dp[i]![j] = Math.max(diag, up, left);
    }
  }

  // Backtrack from (n, m) to (0, 0), collecting pairs in reverse, then flip.
  const reversed: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const matchScore = sim[i - 1]![j - 1]!;
      const diag =
        matchScore === Number.NEGATIVE_INFINITY
          ? Number.NEGATIVE_INFINITY
          : dp[i - 1]![j - 1]! + matchScore;
      // Prefer a real match on ties; it keeps related bullets paired rather
      // than split into an add+remove of equal total score.
      if (diag !== Number.NEGATIVE_INFINITY && dp[i]![j]! === diag) {
        reversed.push({
          kind: "matched",
          id: `m:${i - 1}:${j - 1}`,
          original: original[i - 1]!,
          originalIndex: i - 1,
          proposed: proposed[j - 1]!,
          proposedIndex: j - 1,
        });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    // Tie-break the two gaps so a divergence reads original-then-new: take the
    // removal (up) before the addition (left) when both are optimal.
    if (i > 0 && dp[i]![j]! === dp[i - 1]![j]!) {
      reversed.push({
        kind: "removed",
        id: `del:${i - 1}`,
        original: original[i - 1]!,
        originalIndex: i - 1,
      });
      i -= 1;
      continue;
    }
    // j > 0 here (the loop guard guarantees i>0 || j>0, and i's branch failed).
    reversed.push({
      kind: "added",
      id: `add:${j - 1}`,
      proposed: proposed[j - 1]!,
      proposedIndex: j - 1,
    });
    j -= 1;
  }

  reversed.reverse();
  return reversed;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Detects a rewrite the model botched outright — one that talks about the
 * task instead of doing it, or falls into a repetition loop (#1015).
 *
 * A 2B model on a 4k context occasionally degenerates, and when it does the
 * output is not a weaker rewrite but no rewrite at all: "Here are some
 * examples of how to rewrite the following…" four times over, then "the
 * team's project, and the team's project, and the project…". The number gate
 * (#778) can't see it — garbage often carries no numbers, so it drops none
 * and invents none — and `cleanRewriteLine`'s echo filter only strips exact
 * scaffolding lines. Such a rewrite reached the user as a proposal they had
 * to recognise and reject by hand.
 *
 * `detectGarbledRewrite` is the deterministic check `applyRewriteGates`
 * (`post-process.ts`) runs before the number gate. Every rule compares with
 * the input, so a phrase the user themselves repeated never trips it:
 *
 *   - **Instruction echo.** A line that describes rewriting ("how to
 *     rewrite", "rewrite the following", "let's assume", "Here are …
 *     examples/rewritten/the following") is the model narrating the prompt.
 *     Anchored to prompt vocabulary rather than any "Here are…" opener, so a
 *     bullet like "Here are updated KPIs from Q3" is not caught. A preamble
 *     line that ends in a colon never gets here: `cleanRewriteLine` drops it
 *     as filler, so a good rewrite with a chatty opener is kept.
 *   - **In-line loop.** A word 4-gram three times inside one line. Not a
 *     3-gram: a one-paragraph summary legitimately says "years of experience
 *     in" three times.
 *   - **Cross-line loop.** The same sentence re-emitted: an 8-gram in three
 *     lines, or one line three times. Long enough that a house-style opener
 *     every bullet shares ("Collaborated with cross-functional teams to") is
 *     not a loop.
 *
 * Pure and dependency-free; `garbled-output.test.ts` pins each rule against
 * the degenerate output observed on the PR #1016 preview.
 */

export type GarbledReason = "instruction-echo" | "loop";

const INSTRUCTION_ECHO_PATTERNS: readonly RegExp[] = [
  /\bhow to rewrite\b/,
  /\brewrite the following\b/,
  /\blet'?s assume\b/,
  /^(?:sure\W+)?here(?:'s| is| are)\b.*\b(?:examples?|rewrit\w*|the following)\b/,
];

const IN_LINE_NGRAM = 4;
const IN_LINE_REPEATS = 3;
const CROSS_LINE_NGRAM = 8;
const CROSS_LINE_REPEATS = 3;

function normalize(line: string): string {
  return line.toLowerCase().replace(/[‘’]/g, "'").trim();
}

function words(line: string): string[] {
  return normalize(line).match(/[a-z0-9']+/g) ?? [];
}

/** Count of every word n-gram across `lines`, each line tokenised on its own. */
function ngramCounts(lines: readonly string[], n: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const tokens = words(line);
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join(" ");
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return counts;
}

/** Whether some n-gram reaches `repeats` in `lines` but not in `original`. */
function repeatsBeyondInput(
  lines: readonly string[],
  original: Map<string, number>,
  repeats: number,
  n: number,
): boolean {
  for (const [gram, count] of ngramCounts(lines, n)) {
    if (count >= repeats && (original.get(gram) ?? 0) < repeats) return true;
  }
  return false;
}

/** Whether one output line appears three times, more often than in `original`. */
function repeatedLineBeyondInput(
  original: readonly string[],
  rewritten: readonly string[],
): boolean {
  const count = (lines: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const key = words(line).join(" ");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const before = count(original);
  for (const [line, n] of count(rewritten)) {
    if (n >= CROSS_LINE_REPEATS && (before.get(line) ?? 0) < CROSS_LINE_REPEATS) {
      return true;
    }
  }
  return false;
}

/**
 * Why `rewritten` is garbage rather than a rewrite of `original`, or `null`
 * when it reads as a rewrite. Lines are the cleaned output units
 * (`cleanRewriteLine`); an empty rewrite is `null` — the callers own that
 * failure.
 */
export function detectGarbledRewrite(
  original: readonly string[],
  rewritten: readonly string[],
): GarbledReason | null {
  if (rewritten.length === 0) return null;

  const originalLines = original.map(normalize);
  for (const line of rewritten) {
    const text = normalize(line);
    if (
      INSTRUCTION_ECHO_PATTERNS.some(
        (pattern) =>
          pattern.test(text) && !originalLines.some((o) => pattern.test(o)),
      )
    ) {
      return "instruction-echo";
    }
  }

  const originalInLine = ngramCounts(original, IN_LINE_NGRAM);
  if (
    rewritten.some((line) =>
      repeatsBeyondInput([line], originalInLine, IN_LINE_REPEATS, IN_LINE_NGRAM),
    )
  ) {
    return "loop";
  }
  if (
    repeatsBeyondInput(
      rewritten,
      ngramCounts(original, CROSS_LINE_NGRAM),
      CROSS_LINE_REPEATS,
      CROSS_LINE_NGRAM,
    ) ||
    repeatedLineBeyondInput(original, rewritten)
  ) {
    return "loop";
  }
  return null;
}

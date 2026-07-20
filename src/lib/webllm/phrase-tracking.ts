// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Strong-phrase tracking helpers (issue #67's "track used action verbs **and
 * strong phrases**" requirement — companion to verb-tracking.ts).
 *
 * A "strong phrase" here is a 2-word content-word chunk that follows the
 * leading verb in a rewritten bullet. The intent is the same as verb
 * tracking — flag a recurring phrase across sections as a soft constraint
 * so the next section avoids rote repetition of e.g. "distributed systems"
 * across three roles.
 *
 * Strictly lexical, no NLP model. The post-verb window is scanned for the
 * first two consecutive content words (alphabetic, ≥3 letters, not a
 * stopword). Numeric and currency tokens are skipped — those belong to the
 * number-preservation guardrail, not to phrase dedup. Single-word phrases
 * are not tracked: one repeated word is too noisy a signal at this
 * granularity.
 */

/**
 * Function words, articles, prepositions, and common copulae that should
 * NEVER count as half of a "strong phrase." Lowercased and matched as
 * exact tokens after lowercasing the input. Hand-curated to the words that
 * actually recur in résumé-bullet body text; not exhaustive on purpose.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "for", "with",
  "by", "from", "in", "on", "at", "into", "across", "over", "under",
  "as", "is", "was", "are", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "their", "our", "my",
  "via", "per",
]);

const PHRASE_BRIEF_CAP = 8;

/**
 * Strip leading list/quote noise, skip the leading verb, and scan the rest
 * of the bullet for the first two consecutive content words. Returns the
 * joined phrase (lowercased, single space) or `null` when no two-word
 * phrase can be assembled — short bullets, all-stopword tails,
 * numeric-only tails.
 *
 * Stopwords are checked on the raw lowercased token BEFORE the
 * length-based normalize filter — otherwise short stopwords like "of" /
 * "in" / "to" / "by" get filtered out as noise tokens and never break the
 * collected run. With the early stopword check, "Led the team of five
 * senior engineers" correctly resets twice (at "the" and "of") and lands
 * on "five senior" instead of pulling "team five" across the "of" break.
 */
export function extractStrongPhrase(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^[•\-*]\s*/, "")
    .replace(/^\*+/, "")
    .replace(/^["'`“‘]/, "");
  const rawTokens = stripped.split(/\s+/).map((t) => t.toLowerCase());
  if (rawTokens.length < 3) return null;

  // rawTokens[0] is the leading verb (we don't filter for verb-ness, same
  // as verb-tracking — recurrence is the signal, not lexical category).
  // Per-token classification from index 1 onward:
  //   - stopword       → resets the collected run (forces adjacency)
  //   - numeric/short  → skipped, does NOT reset (so "Drove $1.2M in
  //                      annual recurring" still emits "annual recurring"
  //                      across the metric token)
  //   - content word   → pushed; return as soon as we have two adjacent
  const collected: string[] = [];
  for (let i = 1; i < rawTokens.length; i++) {
    const token = rawTokens[i]!;
    if (STOPWORDS.has(token)) {
      collected.length = 0;
      continue;
    }
    const norm = normalizeToken(token);
    if (norm === null) continue;
    collected.push(norm);
    if (collected.length === 2) return collected.join(" ");
  }
  return null;
}

/**
 * Strip non-alphabetic chars from an already-lowercased token. Returns
 * null for purely numeric/currency tokens (those belong to the
 * number-preservation guardrail) or for tokens with fewer than 3 letters
 * after stripping (too noisy as phrase material — "p99" → "p" → dropped).
 *
 * Stopwords are NOT filtered here — the caller handles stopword detection
 * upstream against the raw token so short stopwords like "of" / "in" still
 * break the collected run.
 */
function normalizeToken(token: string): string | null {
  if (/^\$?\d/.test(token)) return null;
  const stripped = token.replace(/[^a-z'-]/g, "");
  if (stripped.length < 3) return null;
  return stripped;
}

export function buildPhraseBrief(
  usedPhrases: ReadonlySet<string>,
): string | null {
  if (usedPhrases.size === 0) return null;
  const all = Array.from(usedPhrases);
  const recent =
    all.length <= PHRASE_BRIEF_CAP ? all : all.slice(-PHRASE_BRIEF_CAP);
  return `Phrases already used in prior bullets: ${recent.join("; ")}. Avoid repeating these exact phrases.`;
}

/**
 * Mutating helper: extract each line's strong phrase and add it to the
 * running set. The orchestrator owns the Set. Floats a repeated phrase to
 * the tail of the insertion-order Set so the recency cap surfaces fresh
 * repeats.
 */
export function accumulatePhrases(
  lines: readonly string[],
  into: Set<string>,
): void {
  for (const line of lines) {
    const phrase = extractStrongPhrase(line);
    if (phrase === null) continue;
    if (into.has(phrase)) into.delete(phrase);
    into.add(phrase);
  }
}

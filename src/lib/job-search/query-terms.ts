// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * query-terms.ts — the ONE definition of "which words of a `JobQuery` actually
 * do anything", shared by the code that applies them and the code that explains
 * them.
 *
 * WHY THIS MODULE EXISTS. These four helpers were private to `search.ts`, where
 * they decide posting admission (`buildQueryTermPatterns` → `matchesQuery`).
 * `term-quality.ts` has to answer the user-facing half of the same question —
 * *"is this chip of mine pulling any weight?"* — and the only honest answer is
 * the one admission actually uses. A second copy of these rules would let the
 * explanation drift from the behaviour it explains: the UI would mark a term
 * significant while the search silently ignored it, which is worse than saying
 * nothing. So the rules moved DOWN here, to a leaf module, and both callers
 * import them. There is still exactly one copy.
 *
 * WHY A NEW MODULE RATHER THAN EXPORTING FROM `search.ts`. `search.ts` statically
 * imports the ranking tier, which reaches jd-match's skill dictionary. Importing
 * it from a classifier that the `/` lane renders would drag that whole graph into
 * the entry chunk. This module imports NOTHING — that is its point, and the
 * property to preserve when adding to it.
 */

/** Tokens too generic to carry query intent on their own. Module-private: the
 *  predicates below are the supported surface, so callers share the RULE rather
 *  than re-deriving it from the raw word list. */
const STOPWORDS = new Set([
  "and", "or", "the", "of", "for", "with", "in", "at", "to", "on", "an", "a",
]);

/**
 * A skill term is significant enough to filter on when it is 3+ chars, or
 * shorter but symbol-bearing (`c#`, `c++`, `f#`, `.net`) — those are
 * unambiguous, whereas a bare 2-char alpha token (`ai`, `go`, `ml`) matches
 * most of a tech feed's prose and reduces `matchesQuery` to a pass-through.
 *
 * Accepted cost: bare `Go`, `R`, `AI`, `ML` stop contributing to admission.
 * This is acceptable because admission is an OR across all terms (dropping
 * one rarely empties a result set), `matchesQuery` never fails closed (an
 * empty pattern list admits everything), and the dropped term is still
 * rendered as a chip and still reaches the deep links — only its filtering
 * role is removed.
 *
 * Expects an already-trimmed, lowercased term, exactly as `search.ts` calls it.
 */
export function isSignificantSkillTerm(term: string): boolean {
  if (STOPWORDS.has(term)) return false;
  if (term.length >= 3) return true;
  return /[^a-z0-9]/.test(term);
}

/**
 * Split one title-ish string into this filter's title tokens: lowercased, split
 * on everything outside `a-z0-9+#.`, with leading/trailing dots stripped so
 * "Node.js." reads as `node.js`.
 *
 * Used for BOTH `query.titles` (the admission terms) and `query.titleNoise`
 * (#579, the tokens that must NOT admit), so the two are compared in exactly the
 * same token space. That matters: `titleNoise` is derived with
 * `role-keywords.ts`'s `tokenizeWords`, whose punctuation rule differs — "Acme
 * Corp." tokenizes as `corp.` there and `corp` here, and "Yahoo!" as `yahoo!`
 * there and `yahoo` here — so comparing the raw noise strings against these
 * tokens would silently miss every employer name carrying punctuation.
 */
export function titleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

/**
 * `query.titleNoise` re-tokenized into this module's token space — the set a
 * title token must NOT be in to admit anything. `undefined` ⇒ empty set, the
 * pre-#579 behaviour.
 */
export function titleNoiseTokens(titleNoise: readonly string[] | undefined): Set<string> {
  return new Set((titleNoise ?? []).flatMap(titleTokens));
}

/**
 * True when a token drawn from a query TITLE contributes to posting admission:
 * long enough, not a stopword, and not résumé geography/employer noise (#579).
 * The title-side counterpart of `isSignificantSkillTerm` — deliberately a
 * different rule (no symbol-bearing escape hatch, plus the noise subtraction),
 * because titles and skills are different signals; see `buildQueryTermPatterns`.
 */
export function isAdmittingTitleTerm(term: string, noise: ReadonlySet<string>): boolean {
  return term.length >= 3 && !STOPWORDS.has(term) && !noise.has(term);
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared action-verb lexicon — zero dependencies, no domain imports.
 *
 * Two unrelated layers need the same question answered: "does this line lead
 * with an action verb?"
 *
 * - the **scorer** grades a bullet's specificity by it (`score.ts`), and the
 *   rewrite eval extends the set for its `actionVerbLead` criterion
 *   (`webllm/eval/verbs.ts`);
 * - the **parser** uses it as a negative guard: an action-verb lead is the tell
 *   that a candidate role header is really accomplishment prose
 *   (`heuristics/extract/experience.ts` → `looksLikeRoleHeaderTitle`, #662).
 *
 * The set previously lived in `score.ts`, which made the parser's only route to
 * it an import of the whole scorer — pulling the scoring module into the tier-1
 * parse chunk for one `Set` membership test. It lives here instead so both
 * layers share one list without either depending on the other.
 */

/**
 * Curated past-tense action verbs.
 *
 * Kept narrow on purpose: weak generic verbs ("worked", "helped", "supported",
 * "responsible", "assisted", "participated") are deliberately NOT here. A
 * bullet leading with one of those SHOULD fail the scorer's specificity check.
 */
export const ACTION_VERBS: ReadonlySet<string> = new Set([
  "led", "managed", "developed", "built", "designed", "implemented",
  "created", "launched", "drove", "increased", "reduced", "improved",
  "delivered", "established", "optimized", "architected", "scaled",
  "automated", "streamlined", "coordinated", "negotiated", "achieved",
  "spearheaded", "mentored", "transformed", "pioneered", "orchestrated",
  "accelerated", "consolidated", "eliminated", "enhanced", "executed",
  "facilitated", "generated", "integrated", "migrated", "overhauled",
  "redesigned", "refactored", "resolved", "revamped", "simplified",
  "supervised", "trained", "unified", "upgraded",
  // Promoted from the eval-only extension (#622) — past-tense, general
  // register, and squarely in the eng/PM lane this base set already covers.
  "shipped", "owned", "secured", "deployed", "engineered", "rewrote",
  "authored", "analyzed", "conducted", "identified", "presented",
  "produced", "published", "planned",
  // Newly added (#622) — strong outcome verbs missing from both this set
  // and the eval extension.
  "won", "ran", "grew", "founded", "hired", "partnered", "defined", "cut",
  "ported", "rebuilt", "advised", "shaped", "standardized", "instrumented",
]);

/**
 * True when `text`'s first whitespace-delimited token is an action verb.
 *
 * Lowercase the token and strip everything outside `a-z`, so trailing
 * punctuation (`Led,`, `Shipped:`) matches without expanding the set with
 * decorated variants. Returns `false` for empty input.
 *
 * The strip is ASCII-only by design: it is a *first-token* normalizer for an
 * ASCII verb list, not a general folder. A non-ASCII lead ("Élite") reduces to
 * a residue that is simply absent from the set, which is the correct answer.
 */
export function startsWithActionVerb(text: string): boolean {
  const firstWord = text.split(/\s/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (!firstWord) return false;
  return ACTION_VERBS.has(firstWord);
}

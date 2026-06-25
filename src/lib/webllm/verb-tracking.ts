// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Lexical helpers for cross-section action-verb tracking (issue #67).
 *
 * The chain-of-sections orchestrator accumulates the leading verb of every
 * rewritten bullet (and the first word of the rewritten summary), then folds
 * the accumulated set into a soft-constraint sentence ("Verbs already used in
 * prior bullets: built, led, shipped. Choose different verbs where you can.")
 * that is prepended to the user prompt of the next section.
 *
 * Strictly lexical — we do NOT consult the eval rubric's action-verb list
 * (`eval/verbs.ts`) here. The constraint is "don't repeat the verb you
 * already used"; what matters is recurrence, not whether the first word is
 * a "good" verb by some external list. A bullet that opens with a weak verb
 * is still useful context — repeating it would compound the weakness.
 */

/**
 * Strip leading list/quote/punctuation noise that might survive the
 * post-process filter on a model output, then return the lowercased first
 * alphabetic token if one exists. Returns `null` when nothing usable is
 * found.
 *
 * Examples:
 *   "Built a thing"        → "built"
 *   "Led 5 engineers"      → "led"
 *   "Drove $1.2M ARR."     → "drove"
 *   "1. Shipped Foo."      → "shipped"
 *   "**Built** a thing"    → "built"
 *   "  "                   → null
 *   "$1.2M ARR"            → null  (no leading alphabetic token)
 */
export function extractLeadingVerb(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^[•\-*]\s*/, "")
    .replace(/^\*+/, "")
    .replace(/^["'`“‘]/, "");
  const match = stripped.match(/^([A-Za-z][A-Za-z'-]+)/);
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  if (token.length < 2) return null;
  return token;
}

/**
 * The most recent N verbs are the most relevant — they're what's likeliest to
 * recur in the very next section. Older verbs add prompt-context noise that
 * makes small instruct models drop the soft-constraint instruction entirely.
 */
const VERB_BRIEF_CAP = 12;

/**
 * Format the accumulated verb set as a single-sentence soft constraint for
 * the next call's user prompt. Returns `null` when there's nothing to say
 * yet (first section in the chain).
 *
 * The instruction is phrased as a preference ("Choose different verbs where
 * you can") rather than a hard rule. Sometimes the right verb genuinely is
 * "led" again — we want the model to avoid lazy repetition, not refuse a
 * good fit.
 *
 * Returns the most recent `VERB_BRIEF_CAP` verbs in their insertion order
 * (oldest first within the cap) — a Set preserves insertion order in JS, so
 * slicing the tail off `Array.from(set)` keeps the recency window.
 */
export function buildVerbBrief(
  usedVerbs: ReadonlySet<string>,
): string | null {
  if (usedVerbs.size === 0) return null;
  const all = Array.from(usedVerbs);
  const recent =
    all.length <= VERB_BRIEF_CAP ? all : all.slice(-VERB_BRIEF_CAP);
  return `Verbs already used in prior bullets: ${recent.join(", ")}. Choose different verbs where you can.`;
}

/**
 * Mutating helper: extract every line's leading verb and add it to the
 * running set. The orchestrator owns the Set and calls this after each
 * section completes. Verbs are added in encounter order so `buildVerbBrief`
 * surfaces the most recent ones first.
 */
export function accumulateVerbs(
  lines: readonly string[],
  into: Set<string>,
): void {
  for (const line of lines) {
    const verb = extractLeadingVerb(line);
    if (verb === null) continue;
    // Re-insertion is a no-op on Set, but moves nothing — to keep recency
    // semantics we delete-then-add so a repeated verb floats to the tail.
    if (into.has(verb)) into.delete(verb);
    into.add(verb);
  }
}

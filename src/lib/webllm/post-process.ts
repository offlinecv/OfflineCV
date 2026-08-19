// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Post-processing shared by the per-bullet and section rewrite paths. Two
 * stages, in order:
 *
 *   1. {@link cleanRewriteLine} — per-line cleanup of the wrappers small
 *      instruct models put around a bullet.
 *   2. {@link applyNumberPreservation} — the #778 reject gate: a rewrite that
 *      drops a concrete number from the input, or invents one that was never
 *      there, never reaches the user at all.
 *
 * Stage 2 is a whole-rewrite decision, not a per-line one, and that is not a
 * convenience — section rewrite is explicitly allowed to merge, drop and
 * reorder bullets (`MERGE_AND_PRUNE_RULE`), so output line *i* has no owning
 * input bullet to check it against. `$4.2M` moving from bullet 2 to a merged
 * bullet 1 is a correct rewrite; only the whole-section set diff can tell
 * that apart from a drop. Hence a second exported function rather than an
 * extra argument to `cleanRewriteLine`, which stays a pure `string → string`.
 *
 * ---
 *
 * Small instruct models emit a small but persistent set of wrappers
 * around each bullet, even when the system prompt says "no preamble,
 * no quotes":
 *   1. A leading `Rewritten:` echo of the user-prompt suffix.
 *   2. A leading `**Verb**` markdown bold on just the first token
 *      (Gemma 2 under the terse prompt does this often — see #152).
 *   3. A list-marker prefix (`1.`, `1)`, `•`, `-`, `*`).
 *   4. Surrounding quotes — straight (`"…"` `'…'`) and smart (`“…”` `‘…’`).
 *   5. Whole-line markdown emphasis delimiters (`**…**`, `*…*`, `_…_`).
 *
 * Each gets stripped here. The "keep first non-empty line only" behavior
 * deliberately lives at the call site — the per-bullet path wants line 0,
 * the section path wants every non-empty line — so it is not folded in here.
 *
 * Lines that read as the model echoing the system prompt or the
 * user-prompt scaffolding ("Rules:", "Original bullets:", "Rewritten
 * bullets:", or chat-assistant openers like "Here are the rewritten
 * bullets:" — see #150) are returned as empty so the caller's filter
 * drops them.
 */

import { checkNumbersPreserved } from "./preserve-numbers.ts";

/**
 * Exact-match scaffolding lines (post-cleanup). Cheap set lookup for the
 * common case where the model echoes the prompt's section headers.
 */
const PROMPT_ECHO_LINES = new Set([
  "rules:",
  "original bullets:",
  "rewritten bullets:",
  "original:",
  "rewritten:",
]);

/**
 * Llama 3.2 3B (and other chat-tuned models) routinely emits a leading
 * conversational opener like `"Here are the rewritten bullets:"` as its
 * own line before the actual bullets, even when the system prompt says
 * "no preamble." The exact-match set above only catches the canonical
 * `"Rewritten bullets:"` form; this regex catches the chat-opener
 * variants. Anchored to the start of the trimmed line so a legitimate
 * bullet that happens to contain the phrase mid-text doesn't trip.
 *
 * Capture is intentionally narrow to `here is/are (the) rewritten …`
 * — broadening to `new` / `updated` was tempting but risks false
 * positives on bullets like "Here are updated KPIs from Q3." If a model
 * is observed emitting an alternative opener shape in a future
 * committed eval report, widen this pattern then rather than
 * speculating now.
 *
 * Fix for #150.
 */
const CHAT_OPENER_PATTERN = /^here (?:are|is) (?:the )?rewritten\b/i;

/**
 * Strip a leading single-word markdown bold like `**Increased**` when
 * followed by body text. Replaces the bolded token with itself
 * (delimiters dropped) plus the trailing space, preserving the bullet
 * shape. Single-word capture by design — multi-word bolds are usually
 * deliberate emphasis on a phrase and shouldn't be silently flattened.
 *
 * Examples:
 *   `**Increased** weekly active users` → `Increased weekly active users`
 *   `**Streamlined the** checkout`      → unchanged (multi-word bold)
 *   `**X**`                             → unchanged here, handled by the
 *                                         whole-line emphasis strip below
 *
 * Fix for #152.
 */
const LEADING_BOLD_WORD_PATTERN = /^\*\*([A-Za-z][\w-]*)\*\*\s+/;

/**
 * A leading list marker: `1.` / `1)`, `•`, `-`, or `*`.
 *
 * The whitespace rules differ per branch, and each one is load-bearing:
 *
 *   - **Numbered requires `\s+`.** With `\s*` the alternative matches a bare
 *     decimal — `3.` in `3.5x revenue growth` — because zero-or-more trailing
 *     space is satisfied by the `5`. That is harmless while this runs once on
 *     raw model output (a decimal is rarely line-initial there), but
 *     `cleanRewriteLine` re-applies it to lines it has already stripped, so
 *     `- 3.5x revenue growth` became `5x revenue growth`. Silent numeric
 *     corruption on the product path, in a bullet the rewrite prompt actively
 *     asks the model to quantify. Nothing needs a tight `1.Foo`.
 *   - **`-` and `•` allow `\s*`**, so a tight `-Shipped X` still normalizes.
 *   - **`*` requires `\s+`**, because `*X*` is italics and is handled by the
 *     paired-emphasis strip instead.
 */
const LIST_MARKER_PATTERN = /^(?:\d+[.)]\s+|[•\-]\s*|\*\s+)/;

/**
 * Runaway guard for the markdown-prefix loop in `cleanRewriteLine` — not a
 * budget for expected nesting. The loop terminates on its own (every strip
 * only removes characters); this only bounds a hypothetical future strip that
 * grows the line. Set well above any real prefix stack so it never truncates.
 */
const MAX_PREFIX_PASSES = 32;

export function cleanRewriteLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  // Chat-opener preamble check on the RAW trimmed line — before any other
  // transform so we don't accidentally normalize the phrase into something
  // that survives downstream. Returns empty so the caller's filter drops it.
  if (CHAT_OPENER_PATTERN.test(trimmed)) return "";

  // Strip the `Rewritten:` echo first so the prompt-echo check below sees
  // any trailing content the model attached to it.
  const withoutPrefix = trimmed.replace(/^rewritten:\s*/i, "");

  // Markdown-prefix stripping, run to a fixed point.
  //
  // The three strips below shield each other in BOTH directions, which is why
  // no single ordering works (#781):
  //
  //   - The emphasis strip must precede the marker strip, or the leading `*`
  //     of an italicized line (`*Foo.*`) is read as a bullet glyph and the
  //     trailing `*` survives.
  //   - The marker strip must precede the leading-bold strip, or a marker in
  //     front of the bold (`- **Led** the migration`) hides it from
  //     LEADING_BOLD_WORD_PATTERN, which is anchored at `^`. That shipped:
  //     19 of 24 Gemma `terse` bullets in the 2026-08-07 eval reports carried
  //     literal `**` through to `perBullet[].text`, i.e. through to what a
  //     downloaded ATS PDF would render as asterisks. That renderer draws real
  //     bold from its own type scale and never interprets markdown, so a
  //     surviving `**` is always garbage, never formatting.
  //
  // Looping resolves it without having to pick: each pass peels whatever is
  // now outermost, and a marker uncovered on one pass is consumed on the next.
  //
  // ⚠️ The property each strip must hold is IDEMPOTENCE, not termination.
  // Termination is trivially guaranteed — every branch only removes characters,
  // so the line strictly shrinks — and it was never the risk. The real hazard is
  // that a strip safe to apply once to MODEL OUTPUT may not be safe to re-apply
  // to its OWN output, because the loop feeds it a line it has already
  // transformed. LIST_MARKER_PATTERN is where that bit: with `\s*` after the
  // numbered alternative, pass 1 stripped `- ` from `- 3.5x revenue growth` and
  // pass 2 read the uncovered `3.` as a numbered marker, yielding
  // `5x revenue growth`. Requiring `\s+` there is what makes it re-appliable.
  // Any strip added to this loop must be checked the same way.
  //
  // Mid-line bold (`Developed and **implemented** …`) is deliberately NOT
  // handled here. Two tests pin that as intentional — "does NOT strip emphasis
  // mid-line" and "does NOT strip mid-bullet bold emphasis" — on the reasoning
  // that a bold inside a sentence is authored emphasis rather than a model tic.
  // It is also rare in practice: of the 19 affected eval bullets, 18 carried a
  // leading bold only. Reversing that contract is a separate decision from
  // fixing the marker interaction, so it is left to #781's follow-up.
  let body = withoutPrefix;
  let before = "";
  let passes = 0;
  while (body !== before) {
    before = body;

    // Leading `**Verb**` bold (single-word capture) — see the pattern's own
    // docblock for why multi-word bolds are left alone.
    body = body.replace(LEADING_BOLD_WORD_PATTERN, "$1 ");

    // Paired bold/italic wrapping the WHOLE line. Paired (start AND end) so
    // genuine mid-line emphasis is preserved.
    body = body
      .replace(/^\*\*(.+)\*\*$/s, "$1")
      .replace(/^\*(.+)\*$/s, "$1")
      .replace(/^_(.+)_$/s, "$1");

    body = body.replace(LIST_MARKER_PATTERN, "");

    // Runaway guard only. The loop exits on its own the moment a pass changes
    // nothing, and the strictly-shrinking invariant means that always happens;
    // this exists so a future strip that somehow grows the line cannot hang the
    // worker. It is NOT a truncation point tuned to expected input — an earlier
    // revision capped this at 4, which silently gave up on
    // `1. - • - **Led** stuff.` and left the literal `**` this function exists
    // to remove.
    if (++passes >= MAX_PREFIX_PASSES) break;
  }
  const withoutBullet = body;

  // Strip surrounding quotes: straight (" ' `) plus smart double (“ ”) and
  // smart single (‘ ’).
  const withoutQuotes = withoutBullet
    .replace(/^["'`“‘]/, "")
    .replace(/["'`”’]$/, "")
    .trim();

  // Final guard: if the resulting line is just the model echoing prompt
  // scaffolding, drop it so the caller's filter treats it as empty.
  if (PROMPT_ECHO_LINES.has(withoutQuotes.toLowerCase())) return "";

  return withoutQuotes;
}

/** What {@link applyNumberPreservation} decided, and why. */
export interface NumberPreservationOutcome {
  /**
   * The units that may reach the user: the model's rewrite, or — when the
   * rewrite dropped or invented a number — the caller's own `original`,
   * unchanged.
   */
  bullets: string[];
  /**
   * True iff the rewrite was rejected and `bullets` is the original. The UI
   * MUST surface this: a revert and a model that chose to change nothing
   * produce the same empty diff, and letting them look alike is exactly the
   * silent failure #778 exists to remove.
   */
  reverted: boolean;
  /**
   * Property of `bullets` — of what the user actually gets. True whenever
   * `reverted` is true, because the original trivially preserves itself. This
   * is the field the eval rubric re-derives, which is why a reverted rewrite
   * counts toward `numbersPreservedRate`: no number reached the user wrong.
   */
  numbersPreserved: boolean;
  /**
   * Diagnostics about the MODEL'S raw output, kept whether or not it was
   * applied — a non-empty list alongside `numbersPreserved: true` is the
   * revert case, and it is what the revert notice quotes back ("kept your
   * original — the rewrite would have removed $4.2M"). Reading either list as
   * a property of `bullets` is the one misreading to avoid.
   */
  droppedNumbers: string[];
  addedNumbers: string[];
}

/**
 * The #778 reject gate: refuse a rewrite that changes the numeric facts —
 * either by dropping a concrete number or by inventing one.
 *
 * `PRESERVE_NUMBERS_RULE` has been in every rewrite prompt since #609, and the
 * 2026-08-07 eval reports measured every model in the registry breaking it —
 * `numbersPreservedRate` between 0% and 80%, with whole figures (`$4.2M`,
 * `120K`, `14%`) vanishing from rewritten bullets. A prompt cannot be the only
 * enforcement of a rule this load-bearing: a fluent bullet missing its
 * quantification is one the user accepts without re-checking, and
 * quantification is what the score's `Specificity` dimension (weight 0.4)
 * rewards them for having. So the guardrail becomes deterministic here —
 * declining to rewrite beats rewriting away a fact.
 *
 * Gated on the full `ok`, so invention reverts too. #778 shipped drop-only on
 * the reasoning that an invented number arrives *visible* with a warning on
 * it; the eval data retired that. Invention is the worse half for a résumé
 * tool — a dropped figure costs the user a true claim they can restore, an
 * invented one puts a false claim in the document they hand an employer — and
 * a drop-only gate could not reach the ~100% `numbersPreservedRate` #778 asked
 * for, because whole failure cells (Qwen/baseline inventing `30%` on a fixture
 * with zero drops) never triggered it.
 *
 * An empty rewrite is deliberately NOT reverted. Every caller already treats
 * "the model returned nothing" as a failed generation with its own handling;
 * turning it into a silent "kept your original" would hide the failure behind
 * a success, and there is no rewrite there to reject in the first place.
 */
export function applyNumberPreservation(
  original: readonly string[],
  rewritten: readonly string[],
): NumberPreservationOutcome {
  const preservation = checkNumbersPreserved(original, rewritten);
  const shouldRevert = rewritten.length > 0 && !preservation.ok;

  return {
    bullets: shouldRevert ? [...original] : [...rewritten],
    reverted: shouldRevert,
    numbersPreserved: shouldRevert ? true : preservation.ok,
    droppedNumbers: preservation.dropped,
    addedNumbers: preservation.added,
  };
}

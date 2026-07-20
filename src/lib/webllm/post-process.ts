// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Per-line cleanup shared by the per-bullet and section rewrite paths.
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

  // Strip a leading `**Verb**` markdown bold (single-word capture). This
  // runs BEFORE the whole-line emphasis strip because that one requires
  // closing `**` at end-of-line and so doesn't match the inline shape.
  const withoutLeadingBold = withoutPrefix.replace(
    LEADING_BOLD_WORD_PATTERN,
    "$1 ",
  );

  // Strip paired bold/italic markdown delimiters BEFORE list-marker stripping
  // — otherwise the leading `*` of an italicized line (`*Foo.*`) is misread
  // as a bullet glyph and the trailing `*` survives. The pattern is paired
  // (start AND end) so genuine mid-line emphasis is preserved.
  const withoutEmphasis = withoutLeadingBold
    .replace(/^\*\*(.+)\*\*$/s, "$1")
    .replace(/^\*(.+)\*$/s, "$1")
    .replace(/^_(.+)_$/s, "$1");

  // Strip a leading list marker. `-` and `•` allow zero-or-more spaces (a
  // tight `-Shipped X` should still normalize), but `*` requires at least
  // one trailing space — `*X*` is italics and was already handled above.
  const withoutBullet = withoutEmphasis.replace(
    /^(?:\d+[.)]\s*|[•\-]\s*|\*\s+)/,
    "",
  );

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

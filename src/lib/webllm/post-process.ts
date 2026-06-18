// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Per-line cleanup shared by the per-bullet and section rewrite paths.
 *
 * Qwen2.5-1.5B emits a small but persistent set of wrappers around each
 * bullet, even when the system prompt says "no preamble, no quotes":
 *   1. A leading `Rewritten:` echo of the user-prompt suffix.
 *   2. A list-marker prefix (`1.`, `1)`, `•`, `-`, `*`).
 *   3. Surrounding quotes — straight (`"…"` `'…'`) and smart (`“…”` `‘…’`).
 *   4. Markdown bold/italic delimiters (`**…**`, `*…*`, `_…_`).
 *
 * Each gets stripped here. The "keep first non-empty line only" behavior
 * deliberately lives at the call site — the per-bullet path wants line 0,
 * the section path wants every non-empty line — so it is not folded in here.
 *
 * Lines that read as the model echoing the system prompt or the user-prompt
 * scaffolding ("Rules:", "Original bullets:", "Rewritten bullets:") are
 * returned as empty so the caller's filter drops them.
 */

const PROMPT_ECHO_LINES = new Set([
  "rules:",
  "original bullets:",
  "rewritten bullets:",
  "original:",
  "rewritten:",
]);

export function cleanRewriteLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  // Strip the `Rewritten:` echo first so the prompt-echo check below sees
  // any trailing content the model attached to it.
  const withoutPrefix = trimmed.replace(/^rewritten:\s*/i, "");

  // Strip paired bold/italic markdown delimiters BEFORE list-marker stripping
  // — otherwise the leading `*` of an italicized line (`*Foo.*`) is misread
  // as a bullet glyph and the trailing `*` survives. The pattern is paired
  // (start AND end) so genuine mid-line emphasis is preserved.
  const withoutEmphasis = withoutPrefix
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

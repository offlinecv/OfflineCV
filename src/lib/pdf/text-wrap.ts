// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * text-wrap — the shared greedy word-wrap used by both PDF renderers
 * (`render-ats-pdf.ts` and `render-audit-report.ts`), extracted so a wrap
 * improvement lands once instead of in two byte-for-byte copies (#421 review).
 *
 * The measurer is a minimal `{ widthOfTextAtSize }` interface so this leaf
 * imports no pdf-lib types — both pdf-lib font objects satisfy it.
 */

/** Minimal font shape: the width of `text` at `size`, in points. Both pdf-lib
 *  `StandardFont` and embedded-font objects satisfy this. */
export interface TextMeasurer {
  widthOfTextAtSize(text: string, size: number): number;
}

/**
 * The "first-line inset" wrap rule shared by `wrapWordsToLines` here and
 * `wrapSegmentsToLines` in `render-ats-pdf.ts` (#881 review) — extracted so the
 * empty-line-0 rule can't drift between the word wrapper and the atomic-segment
 * wrapper the way the rest of this module's docblock already guards against for
 * a whole-wrap-improvement duplication (#421).
 *
 * `limit()` returns the width the line currently being packed (`lines.length`)
 * should wrap to: `firstLineMaxWidth` for line 0, `maxWidth` for every line
 * after it. `needsEmptyFirstLine` reports whether the very first unit (a word
 * or a segment) doesn't fit beside the inset at all — when it doesn't, the
 * caller seats an empty line 0 so that unit starts fresh on line 1 instead of
 * running past the inset's right edge.
 */
export function firstLineInset(
  lines: string[],
  maxWidth: number,
  firstLineMaxWidth: number,
): { limit: () => number; needsEmptyFirstLine: (unitWidth: number) => boolean } {
  return {
    limit: () => (lines.length === 0 ? firstLineMaxWidth : maxWidth),
    needsEmptyFirstLine: (unitWidth: number) =>
      lines.length === 0 && firstLineMaxWidth < maxWidth && unitWidth > firstLineMaxWidth,
  };
}

/**
 * Break a single word that is itself wider than `maxWidth` into character-run
 * chunks that each fit. Guarantees progress (at least one char per chunk) so a
 * pathologically narrow `maxWidth` still terminates.
 */
function breakLongWord(
  word: string,
  font: TextMeasurer,
  size: number,
  maxWidth: number,
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of word) {
    const candidate = chunk + ch;
    if (chunk !== "" && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(chunk);
      chunk = ch;
    } else {
      chunk = candidate;
    }
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

/**
 * Greedy `\s+`-word wrap: pack words up to `maxWidth`.
 *
 * A single word wider than `maxWidth`:
 *   - `breakLongWords: false` (default) → emitted as its own (overflowing) line.
 *     Preserves the round-trip-critical "never split a skill/segment mid-word"
 *     contract the résumé renderer depends on (#301).
 *   - `breakLongWords: true` → split at character boundaries so it never runs
 *     past the page margin — used by the audit-report identity header, where a
 *     long URL is a single word with no interior whitespace and there is no
 *     re-parse invariant to protect (#421 Blocking #5).
 *
 * `firstLineMaxWidth` narrows line 0 only, for a caller drawing an inset ahead
 * of it (the bold category label on a skills line, #881). When nothing fits
 * beside the inset, line 0 comes back EMPTY and the words start on line 1 —
 * the inset then owns its own line instead of pushing the first word past the
 * right margin. Defaulting it to `maxWidth` disables both the narrowing and the
 * empty-line rule, so every existing caller wraps exactly as before.
 *
 * Always terminates: without breaking, an overlong word advances the loop as
 * its own line; with breaking, `breakLongWord` makes at least one char of
 * progress per chunk.
 */
export function wrapWordsToLines(
  words: string[],
  font: TextMeasurer,
  size: number,
  maxWidth: number,
  breakLongWords = false,
  firstLineMaxWidth = maxWidth,
): string[] {
  if (words.length === 0) return [];
  const lines: string[] = [];
  const { limit, needsEmptyFirstLine } = firstLineInset(
    lines,
    maxWidth,
    firstLineMaxWidth,
  );
  let current = "";
  for (const word of words) {
    // Extend the current line when the word still fits alongside it; otherwise
    // flush it and fall through to seat `word` on a fresh (empty) line.
    if (current !== "") {
      const candidate = `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= limit()) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = "";
    }
    // `current` is empty here: seat `word` as the start of a new line. A word
    // that alone overflows is broken across lines when asked, else emitted whole
    // (the round-trip-safe overflow the résumé renderer relies on).
    if (needsEmptyFirstLine(font.widthOfTextAtSize(word, size))) {
      lines.push("");
    }
    if (breakLongWords && font.widthOfTextAtSize(word, size) > limit()) {
      const chunks = breakLongWord(word, font, size, limit());
      lines.push(...chunks.slice(0, -1));
      current = chunks[chunks.length - 1] ?? "";
    } else {
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

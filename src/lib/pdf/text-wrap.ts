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
): string[] {
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // Extend the current line when the word still fits alongside it; otherwise
    // flush it and fall through to seat `word` on a fresh (empty) line.
    if (current !== "") {
      const candidate = `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = "";
    }
    // `current` is empty here: seat `word` as the start of a new line. A word
    // that alone overflows is broken across lines when asked, else emitted whole
    // (the round-trip-safe overflow the résumé renderer relies on).
    if (breakLongWords && font.widthOfTextAtSize(word, size) > maxWidth) {
      const chunks = breakLongWord(word, font, size, maxWidth);
      lines.push(...chunks.slice(0, -1));
      current = chunks[chunks.length - 1] ?? "";
    } else {
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

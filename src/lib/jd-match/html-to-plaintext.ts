// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Pure HTML-to-plaintext normalizer, deliberately split out of `fetch-jd.ts`
// (#704). `fetch-jd.ts` also owns live `fetch()` calls to the ATS platforms,
// so anything that imports from it pulls a network primitive into its import
// graph. This module has zero dependencies and makes no network calls, so a
// consumer that audits its own import graph for network primitives (or wants
// this repo's HTML normalizer without forking it) can import it directly
// without that audit ever seeing a `fetch(` literal.

/**
 * Resolve a numeric character reference's code point to its character, leaving
 * the original `&#…;` text untouched when the value isn't a valid Unicode
 * scalar (out of the 0–0x10FFFF range, or a lone surrogate). This keeps a
 * malformed/overflowing reference visible rather than throwing or emitting U+FFFD.
 *
 * Code point 0xA0 (non-breaking space) is folded to a regular space so numeric
 * `&#160;` / `&#xA0;` references match the named `&nbsp;` decode path.
 *
 * Non-whitespace C0 control characters and DEL (e.g. `&#0;`, `&#7;`, `&#8;`) are
 * dropped — decoding them would inject invisible control bytes into the matched
 * plaintext. Tab / LF / CR are kept as legitimate whitespace (the line-collapse
 * pass downstream normalizes them).
 */
function decodeCodePoint(original: string, codePoint: number): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return original;
  }
  if (codePoint === 0xa0) return " ";
  if (
    (codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d) ||
    codePoint === 0x7f
  ) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

export function htmlToPlaintext(html: string): string {
  // Strip <style> and <script> blocks
  let text = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // Convert block-end tags to newlines
  text = text.replace(/<\/(p|li|div|tr)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common named HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Decode numeric character references (decimal &#160; and hex &#x2013;).
  // Generators such as Lever lean on these for typographic punctuation; left
  // raw they leak `&#…;` fragments into the JD-match passes. Malformed refs
  // like `&#x;` never match (the digit group requires 1+); out-of-range or
  // surrogate code points are preserved by decodeCodePoint.
  text = text
    .replace(/&#(\d+);/g, (m, n: string) => decodeCodePoint(m, parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) =>
      decodeCodePoint(m, parseInt(h, 16)),
    );

  // Collapse trailing spaces on each line, then collapse 3+ newlines to 2
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

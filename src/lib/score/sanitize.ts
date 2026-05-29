// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Text sanitization utilities.
 * Two layers: db-safe (blocks store-write failures from invalid code points)
 * and ats-safe (improves how generic text extractors read the result).
 *
 * The ATS normalization rules are adapted from career-ops (MIT).
 */

/**
 * Layer 1: Strip characters that PostgreSQL rejects in text/JSONB columns.
 *
 * - Null bytes (\x00) and escaped null (\u0000)
 * - Lone surrogates (U+D800–U+DFFF) — icon fonts in PDFs produce these
 * - Replacement character (U+FFFD) — noise from bad extraction
 */
export function sanitizeForDb(text: string): string {
  return text
    .replace(/\x00/g, "")
    .replace(/\\u0000/g, "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/\uFFFD/g, "");
}

/**
 * Sanitize a JSON-stringified object for PostgreSQL.
 * Use when inserting JSONB: `JSON.parse(sanitizeJsonForDb(JSON.stringify(obj)))`
 */
export function sanitizeJsonForDb(json: string): string {
  return sanitizeForDb(json);
}

/**
 * Layer 2: Normalize typographic characters that break ATS keyword matching.
 * Calls sanitizeForDb first, then applies ATS-specific replacements.
 *
 * Adapted from career-ops normalizeTextForATS() (MIT license).
 * Character classes:
 * - Em/en dashes → hyphen
 * - Smart quotes → straight quotes
 * - Ellipsis → three dots
 * - Zero-width characters → removed
 * - Non-breaking space → regular space
 */
export function normalizeForAts(text: string): string {
  let result = sanitizeForDb(text);

  // Dashes: em-dash (U+2014), en-dash (U+2013) → hyphen
  result = result.replace(/[\u2013\u2014]/g, "-");

  // Smart double quotes: U+201C, U+201D, U+201E, U+201F → straight double quote
  result = result.replace(/[\u201C\u201D\u201E\u201F]/g, '"');

  // Smart single quotes: U+2018, U+2019, U+201A, U+201B → straight single quote/apostrophe
  result = result.replace(/[\u2018\u2019\u201A\u201B]/g, "'");

  // Ellipsis: U+2026 → three dots
  result = result.replace(/\u2026/g, "...");

  // Zero-width characters: ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D),
  // Word Joiner (U+2060), BOM/ZWNBSP (U+FEFF)
  result = result.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "");

  // Non-breaking space: U+00A0 → regular space
  result = result.replace(/\u00A0/g, " ");

  return result;
}

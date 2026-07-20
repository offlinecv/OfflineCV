// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared regex shapes for the JD-match passes.
 *
 * Both the skill-alias regex (built once at module load in `skills.ts`) and
 * the resume-corpus mention probes (in `coverage.ts`) need the same notion
 * of "word boundary" — `\b` mis-segments aliases that contain punctuation
 * (`react.js`, `c++`, `.net`, `c#`), so we use lookarounds that treat
 * whitespace plus a small punctuation set as the boundary.
 */

/** Required-prefix lookaround (start of string or one of our boundary chars). */
export const ALIAS_BOUNDARY_PREFIX =
  "(?:^|[\\s,;:.()\\[\\]/'\"\\u2013\\u2014])";

/** Required-suffix lookahead (end of string or one of our boundary chars). */
export const ALIAS_BOUNDARY_SUFFIX =
  "(?=$|[\\s,;:.()\\[\\]/'\"\\u2013\\u2014])";

/** Escape a literal string for safe inclusion inside a `RegExp` source. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

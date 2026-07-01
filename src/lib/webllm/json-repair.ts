// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JSON repair ladder for small on-device LLM outputs.
 *
 * Small models often wrap valid JSON in markdown fences or add prose before/
 * after the value. This module is the single, production-grade repair helper
 * shared by every WebLLM caller that expects JSON back — object callers
 * (`parse-resume.ts`, `analyze-resume.ts`) via `tryParseJsonObject`, and the
 * top-level-array caller (`jd-match/llm/extract-requirements.ts`) via
 * `tryParseJsonArray`. It is intentionally separate from `spike/` (which is
 * dev-only and must not leak into the prod bundle).
 *
 * The ladder is: strict parse → strip ``` fences → walk the first balanced
 * span (`{...}` for objects, `[...]` for arrays), skipping string literals so a
 * bracket inside a value can't close the span early. Branch coverage is
 * asserted via `parse-resume.test.ts`, `analyze-resume.test.ts`, and
 * `json-repair.test.ts`.
 */

export type JsonParseOutcome =
  | { ok: true; value: unknown }
  | { ok: false };

/**
 * Try hard to parse a JSON OBJECT out of an LLM response. Returns `{ok: false}`
 * only when every step of the repair ladder fails — callers should fall back to
 * a safe empty shape in that case (never throw to the user).
 */
export function tryParseJsonObject(raw: string): JsonParseOutcome {
  return runRepairLadder(raw, extractFirstBalancedObject);
}

/**
 * Array mirror of {@link tryParseJsonObject}: recover a top-level JSON ARRAY
 * from small-model output. Same repair ladder, scanning for the first balanced
 * `[...]` span. Returns `{ok: false}` when every step fails, so the caller owns
 * the fallback (the requirement extractor turns this into a thrown error and
 * the orchestrator falls back to the deterministic keyword path).
 */
export function tryParseJsonArray(raw: string): JsonParseOutcome {
  return runRepairLadder(raw, extractFirstBalancedArray);
}

/**
 * Shared repair ladder over `raw`: (1) strict `JSON.parse`, (2) strip
 * ```` ```json ```` / bare ```` ``` ```` fences, (3) extract the first balanced
 * span via `extractSpan` (handles prose/fences before AND after the JSON). A
 * greedy regex would run to the last bracket in the string and swallow trailing
 * prose; the balanced-span scan avoids that. Returns `{ok: false}` when nothing
 * parses.
 */
function runRepairLadder(
  raw: string,
  extractSpan: (s: string) => string | null,
): JsonParseOutcome {
  const attempt = (s: string): JsonParseOutcome => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return { ok: false };
    }
  };

  // 1. Strict parse.
  const strict = attempt(raw);
  if (strict.ok) return strict;

  // 2. Strip ```json ... ``` (and bare ``` ... ```) fences.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const fenced = attempt(stripped);
  if (fenced.ok) return fenced;

  // 3. Extract the first *balanced* span.
  const span = extractSpan(stripped);
  if (span !== null) {
    const extracted = attempt(span);
    if (extracted.ok) return extracted;
  }

  return { ok: false };
}

/** First balanced `{...}` substring of `s`, or null. */
function extractFirstBalancedObject(s: string): string | null {
  return extractFirstBalancedSpan(s, "{", "}");
}

/** First balanced `[...]` substring of `s`, or null. */
function extractFirstBalancedArray(s: string): string | null {
  return extractFirstBalancedSpan(s, "[", "]");
}

/**
 * Return the first balanced `open`…`close` substring of `s`, or null if there
 * is no balanced span. String literals (and their `\"` escapes) are skipped so
 * a bracket inside a JSON string value never miscounts the depth.
 *
 * The branch count is irreducible for a correct scanner (string-literal skip +
 * escape handling + depth tracking are the whole point); splitting it would add
 * indirection without lowering risk.
 */
// fallow-ignore-next-line complexity
function extractFirstBalancedSpan(
  s: string,
  open: string,
  close: string,
): string | null {
  const start = s.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

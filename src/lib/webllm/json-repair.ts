// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JSON repair ladder for small on-device LLM outputs.
 *
 * Small models often wrap valid JSON in markdown fences or add prose before/
 * after the object. This module is the single, production-grade repair helper
 * shared by every WebLLM caller that expects a JSON object back
 * (`parse-resume.ts`, `analyze-resume.ts`). It is intentionally separate from
 * `spike/` (which is dev-only and must not leak into the prod bundle).
 *
 * The ladder is: strict parse → strip ``` fences → walk the first balanced
 * `{...}` span (skipping string literals so a brace inside a value can't close
 * the object early). Branch coverage is asserted via `parse-resume.test.ts`
 * and `analyze-resume.test.ts`.
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
  const attempt = (s: string): JsonParseOutcome => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return { ok: false };
    }
  };

  // 1. Strict parse
  const strict = attempt(raw);
  if (strict.ok) return strict;

  // 2. Strip ```json ... ``` (and bare ``` ... ```) fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const fenced = attempt(stripped);
  if (fenced.ok) return fenced;

  // 3. Extract the first *balanced* `{...}` span (handles prose/fences before
  //    AND after the JSON). A greedy regex (`/\{[\s\S]*\}/`) would run to the
  //    last `}` in the string and swallow trailing prose that happens to
  //    contain a brace (e.g. "...}\nNote: use {name} as a placeholder"),
  //    failing the parse and silently dropping otherwise-valid output. Walk
  //    brace depth instead, skipping over string literals so a `}` inside a
  //    value doesn't close the object early.
  const span = extractFirstBalancedObject(stripped);
  if (span !== null) {
    const extracted = attempt(span);
    if (extracted.ok) return extracted;
  }

  return { ok: false };
}

/**
 * Return the first balanced `{...}` substring of `s`, or null if there is no
 * balanced object. String literals (and their `\"` escapes) are skipped so a
 * brace inside a JSON string value never miscounts the depth.
 *
 * The branch count is irreducible for a correct scanner (string-literal skip +
 * escape handling + depth tracking are the whole point); splitting it would add
 * indirection without lowering risk.
 */
// fallow-ignore-next-line complexity
function extractFirstBalancedObject(s: string): string | null {
  const start = s.indexOf("{");
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
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

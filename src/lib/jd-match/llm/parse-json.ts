// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Tolerant JSON extraction for small-model output (issue #200).
 *
 * On-device models routinely wrap JSON in markdown fences or trailing prose.
 * This parser recovers the first balanced JSON value — array OR object — from
 * such output and returns a discriminated `{ ok }` result, so a hard parse
 * failure is a *signal* the caller can act on (the requirement extractor turns
 * `{ ok: false }` into a thrown error; the orchestrator falls back to keyword).
 *
 * Mirrors the proven repair ladder in `src/lib/webllm/parse-resume.ts`
 * (`tryParseJsonObject` / `extractFirstBalancedObject`), generalized from
 * object-only to array-or-object. Kept as a production copy on purpose:
 * `spike/` is dev-only and must not be imported, and parse-resume's scanner is
 * `{`-only.
 */

export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

/**
 * Parse `raw` into a JSON value, tolerating the common ways a small model
 * dirties its output. Ladder: (1) strict parse, (2) strip ``` ```json ``` ```
 * fences, (3) extract the first balanced `[...]` or `{...}` span (prose before
 * AND after the JSON is discarded). Returns `{ ok: false }` when nothing parses.
 */
export function parseJsonLoose(raw: string): JsonParseResult {
  const attempt = (s: string): JsonParseResult => {
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

  // 3. Extract the first *balanced* `[...]` or `{...}` span. Walk bracket depth,
  //    skipping string literals so a bracket inside a value never closes the
  //    span early (a greedy regex would run to the last bracket and swallow
  //    trailing prose).
  const span = extractFirstBalancedSpan(stripped);
  if (span !== null) {
    const extracted = attempt(span);
    if (extracted.ok) return extracted;
  }

  return { ok: false };
}

/**
 * Return the first balanced `[...]` or `{...}` substring of `s`, or null if
 * there is none. Whichever of `[` / `{` appears first is the opener; the scan
 * balances to its matching closer. String literals (and their `\"` escapes) are
 * skipped so a bracket inside a string value never miscounts the depth.
 *
 * The branch count is irreducible for a correct scanner (opener selection +
 * string-literal skip + escape handling + depth tracking are the whole point);
 * splitting it would add indirection without lowering risk. Branch coverage is
 * asserted via parse-json.test.ts.
 */
// fallow-ignore-next-line complexity
function extractFirstBalancedSpan(s: string): string | null {
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return null;

  // Pick the earliest opener that exists.
  const useArray = firstObj === -1 || (firstArr !== -1 && firstArr < firstObj);
  const start = useArray ? firstArr : firstObj;
  const open = useArray ? "[" : "{";
  const close = useArray ? "]" : "}";

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

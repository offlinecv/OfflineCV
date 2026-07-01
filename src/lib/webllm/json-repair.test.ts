// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for the shared JSON repair ladder. Pure functions — no engine, no
 * DOM. The object path is also exercised indirectly by `parse-resume.test.ts`
 * and `analyze-resume.test.ts`; here we pin the top-level-array path
 * (`tryParseJsonArray`, added for the JD requirement extractor, #200) and the
 * string-literal-aware balanced-span scan for both shapes.
 */

import { describe, it, expect } from "vitest";
import { tryParseJsonArray, tryParseJsonObject } from "./json-repair.ts";

describe("tryParseJsonArray", () => {
  it("parses a strict JSON array", () => {
    const r = tryParseJsonArray('[{"id":"req-1"}]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ id: "req-1" }]);
  });

  it("parses an array wrapped in ```json fences", () => {
    const r = tryParseJsonArray('```json\n[{"a":1}]\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ a: 1 }]);
  });

  it("extracts the array from prose before AND after it", () => {
    const r = tryParseJsonArray(
      'Here are the requirements:\n[{"a":1},{"a":2}]\nHope that helps!',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("does not close the span on a bracket inside a string value", () => {
    const r = tryParseJsonArray(
      'noise [{"text":"use [brackets] and }braces{ here"}] tail',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([{ text: "use [brackets] and }braces{ here" }]);
    }
  });

  it("ignores a leading object and recovers the array span", () => {
    const r = tryParseJsonArray('note {"skip":true}\n[{"a":1}]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ a: 1 }]);
  });

  it("does not recover an object when only an array span is sought", () => {
    // Strict parse fails (prose around it), so the balanced-span step runs — and
    // it looks for `[...]` only, so a lone object in prose is NOT recovered.
    // (Shape enforcement past a bare strict-parse is the caller's job.)
    expect(tryParseJsonArray('note: {"id":"req-1"} end').ok).toBe(false);
  });

  it("signals failure when there is no JSON", () => {
    expect(tryParseJsonArray("no json here").ok).toBe(false);
  });

  it("signals failure on an unbalanced / truncated array", () => {
    expect(tryParseJsonArray('[{"a":1},').ok).toBe(false);
  });

  it("signals failure on empty input", () => {
    expect(tryParseJsonArray("").ok).toBe(false);
  });
});

describe("tryParseJsonObject (refactor guard)", () => {
  it("extracts a balanced object span from surrounding prose", () => {
    const r = tryParseJsonObject('prefix {"ok":true} suffix');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: true });
  });

  it("signals failure when there is no object", () => {
    expect(tryParseJsonObject("no json here").ok).toBe(false);
  });
});

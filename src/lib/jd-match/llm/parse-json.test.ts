// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for parseJsonLoose (#200). Pure function — no engine, no DOM.
 * Covers the repair ladder (strict → fences → balanced span) for both arrays
 * and objects, the string-literal-aware depth scan, and the failure signal.
 */

import { describe, it, expect } from "vitest";
import { parseJsonLoose } from "./parse-json.ts";

describe("parseJsonLoose", () => {
  it("parses a strict JSON array", () => {
    const r = parseJsonLoose('[{"id":"req-1"}]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ id: "req-1" }]);
  });

  it("parses an array wrapped in ```json fences", () => {
    const r = parseJsonLoose('```json\n[{"a":1}]\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ a: 1 }]);
  });

  it("extracts the array from prose before AND after it", () => {
    const r = parseJsonLoose(
      'Here are the requirements:\n[{"a":1},{"a":2}]\nHope that helps!',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("does not close the span on a bracket inside a string value", () => {
    const r = parseJsonLoose(
      'noise [{"text":"use [brackets] and }braces{ here"}] tail',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([{ text: "use [brackets] and }braces{ here" }]);
    }
  });

  it("extracts a balanced object span too", () => {
    const r = parseJsonLoose('prefix {"ok":true} suffix');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: true });
  });

  it("picks the earliest opener when both [ and { appear", () => {
    const r = parseJsonLoose('[{"a":1}] then {"b":2}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ a: 1 }]);
  });

  it("signals failure when there is no JSON", () => {
    expect(parseJsonLoose("no json here").ok).toBe(false);
  });

  it("signals failure on an unbalanced / truncated array", () => {
    expect(parseJsonLoose('[{"a":1},').ok).toBe(false);
  });

  it("signals failure on empty input", () => {
    expect(parseJsonLoose("").ok).toBe(false);
  });
});

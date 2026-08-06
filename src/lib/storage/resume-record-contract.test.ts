// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Résumé-record contract tests (#757). Modeled on
 * `job-record-contract.test.ts`: a drift-guard pass over
 * {@link RESUME_RECORD_RULES} exercises every field with no per-field
 * maintenance, on top of the named-case coverage the issue's acceptance
 * criteria call for.
 */

import { describe, expect, it } from "vitest";
import {
  RESUME_RECORD_RULES,
  validateResumeRecord,
} from "./resume-record-contract.ts";

/** A record every rule accepts — the baseline each case perturbs one field of.
 *  `blobBase64`/`blobType` are deliberately absent: they are not part of this
 *  contract (validated at the `backup.ts` call site instead). */
function validRecord(): Record<string, unknown> {
  return {
    id: "resume-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    filename: "cv.pdf",
    parse: { result: { marker: "cascade-42" }, score: { overall: 72 }, sourceKind: "pdf" },
  };
}

function reasons(value: unknown): string[] {
  const result = validateResumeRecord(value);
  return result.ok ? [] : result.reasons;
}

describe("validateResumeRecord: the baseline", () => {
  it("accepts a fully-populated record unchanged", () => {
    const result = validateResumeRecord(validRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual(validRecord());
  });

  it("accepts the minimum: an id and a filename, with parse absent", () => {
    const result = validateResumeRecord({ id: "resume-1", filename: "cv.pdf" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("parse" in result.record).toBe(false);
  });

  it.each([
    ["a non-object", "not a record"],
    ["null", null],
    ["an array", [{ id: "resume-1", filename: "cv.pdf" }]],
  ])("refuses %s", (_label, value) => {
    expect(reasons(value)[0]).toMatch(/must be a plain JSON object/);
  });
});

describe("validateResumeRecord: the named refusals", () => {
  it("refuses a missing id", () => {
    expect(reasons({ filename: "cv.pdf" })).toContainEqual(expect.stringContaining("`id`"));
  });

  it("refuses an empty id", () => {
    expect(reasons({ id: "", filename: "cv.pdf" })).toContainEqual(
      expect.stringContaining("`id`"),
    );
  });

  it("refuses a missing filename", () => {
    expect(reasons({ id: "resume-1" })).toContainEqual(expect.stringContaining("`filename`"));
  });

  it("refuses an empty filename", () => {
    expect(reasons({ id: "resume-1", filename: "" })).toContainEqual(
      expect.stringContaining("`filename`"),
    );
  });

  it("refuses a non-string filename", () => {
    expect(reasons({ id: "resume-1", filename: 42 })).toContainEqual(
      expect.stringContaining("`filename`"),
    );
  });

  it("refuses a record carrying a `__proto__` key", () => {
    const hostile = JSON.parse(
      '{"id":"resume-1","filename":"cv.pdf","__proto__":{"admin":true}}',
    ) as unknown;
    expect(reasons(hostile)[0]).toMatch(/__proto__/);
  });

  it("refuses a non-JSON-safe `parse`", () => {
    expect(reasons({ ...validRecord(), parse: { at: new Date() } })).toContainEqual(
      expect.stringContaining("parse.at"),
    );
  });

  it("refuses a `parse` that is not a plain object", () => {
    expect(reasons({ ...validRecord(), parse: "not an object" })).toContainEqual(
      expect.stringContaining("`parse`"),
    );
  });

  it("refuses a `parse` carrying a nested `__proto__` key", () => {
    const hostile = JSON.parse(
      '{"id":"resume-1","filename":"cv.pdf","parse":{"__proto__":{"admin":true}}}',
    ) as unknown;
    expect(reasons(hostile)[0]).toMatch(/__proto__/);
  });
});

describe("validateResumeRecord: `parse` absent is accepted — it is a legal shape, not a refusal", () => {
  it("accepts a record with no `parse` key at all", () => {
    const result = validateResumeRecord({ id: "resume-1", filename: "cv.pdf" });
    expect(result.ok).toBe(true);
  });

  it("normalises `parse: null` to absent, the same legal state readSnapshot treats it as", () => {
    const result = validateResumeRecord({ id: "resume-1", filename: "cv.pdf", parse: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("parse" in result.record).toBe(false);
  });

  it("does NOT require `parse.result`/`parse.score` — storage treats `parse` as opaque", () => {
    // The résumé contract deliberately does not assert the SavedResumeSnapshot
    // shape (`result`/`score`/`sourceKind`/`shapeVersion`) — that belongs to
    // `resume-library.ts`, one layer up. `listLibrary`'s `hasCachedParse` is
    // where an unreadable-but-JSON-safe `parse` is reported, not here.
    const result = validateResumeRecord({
      id: "resume-1",
      filename: "cv.pdf",
      parse: { anything: "goes" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.parse).toEqual({ anything: "goes" });
  });
});

describe("validateResumeRecord: unknown extra keys are PRESERVED", () => {
  it("carries an unrecognised field onto the stored record", () => {
    const result = validateResumeRecord({ ...validRecord(), sourceDevice: "laptop" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.record as unknown as Record<string, unknown>).sourceDevice).toBe("laptop");
  });

  it("still requires an extra key's value to be JSON-safe", () => {
    expect(reasons({ ...validRecord(), extra: { when: new Date() } })).toContainEqual(
      expect.stringContaining("record.extra.when"),
    );
  });

  it("does not resurrect a KNOWN field that failed its rule", () => {
    const result = validateResumeRecord({ ...validRecord(), filename: 42 });
    expect(result.ok).toBe(false);
  });
});

describe("drift guard: every declared rule actually rejects something", () => {
  // Iterates the rule map rather than a hand-written field list, so a field
  // added to `ResumeRecord` (other than `blob`) — which `tsc` forces into the
  // map — is covered here with no edit.
  it.each(Object.keys(RESUME_RECORD_RULES))(
    "`%s` refuses a value no field type admits",
    (field) => {
      const result = validateResumeRecord({ ...validRecord(), [field]: () => "nope" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasons.join(" ")).toContain(field);
    },
  );

  it("names every rule's expectation, so a refusal tells a producer what to send", () => {
    for (const [field, rule] of Object.entries(RESUME_RECORD_RULES)) {
      expect(rule.expected, field).toMatch(/\S/);
    }
  });
});

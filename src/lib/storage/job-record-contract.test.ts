// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Capture-contract validation (#693).
 *
 * The drift guard is layered, and only the first layer is a real guarantee:
 *
 *  1. `JOB_RECORD_RULES` is a mapped type over `keyof Required<JobRecord>`, so
 *     adding a field to `JobRecord` without a rule for it fails `tsc` — the
 *     `typecheck` step, not this file. Types are erased at runtime, so no
 *     vitest assertion can enumerate an interface's keys; a runtime list of
 *     today's fields would pass forever and is exactly the check the issue
 *     calls worse than nothing.
 *  2. The `it.each` over the rule map below then exercises every field the map
 *     declares, with no per-field maintenance. That catches the other half of
 *     drift: a rule added to satisfy (1) whose `check` doesn't actually check.
 */

import { describe, expect, it } from "vitest";
import {
  JOB_RECORD_RULES,
  isKnownStatus,
  validateJobRecord,
} from "./job-record-contract.ts";
// Moved to `record-contract.ts` with the rest of the machinery the job and
// letter contracts share (#711); the behaviour asserted below is unchanged.
import { findJsonSafetyProblem } from "./record-contract.ts";

/** A record every rule accepts — the baseline each case perturbs one field of. */
function validRecord(): Record<string, unknown> {
  return {
    id: "job-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    title: "Senior Frontend Engineer",
    company: "Acme",
    url: "https://acme.com/jobs/1",
    notes: "referred by a friend",
    status: "applied",
    resumeId: "resume-1",
    jdText: "We are hiring.",
    matchResult: { coverage: 0.8, missing: ["kubernetes"] },
    capture: { contract: 1, producer: "offlinecv-extension", producerVersion: "0.1.0" },
  };
}

function reasons(value: unknown): string[] {
  const result = validateJobRecord(value);
  return result.ok ? [] : result.reasons;
}

describe("validateJobRecord: the baseline", () => {
  it("accepts a fully-populated record unchanged and without warnings", () => {
    const result = validateJobRecord(validRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual(validRecord());
    expect(result.warnings).toEqual([]);
  });

  it("accepts the minimum: an id and a title", () => {
    const result = validateJobRecord({ id: "job-1", title: "SWE" });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a non-object", "not a record"],
    ["null", null],
    ["an array", [{ id: "job-1", title: "SWE" }]],
  ])("refuses %s", (_label, value) => {
    expect(reasons(value)[0]).toMatch(/must be a plain JSON object/);
  });
});

describe("validateJobRecord: the four named refusals", () => {
  it("refuses a missing title", () => {
    expect(reasons({ id: "job-1" })).toContainEqual(expect.stringContaining("`title`"));
  });

  it("refuses a non-string title", () => {
    expect(reasons({ id: "job-1", title: 42 })).toContainEqual(
      expect.stringContaining("`title`"),
    );
  });

  it("refuses an absolute url whose scheme is not http(s)", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      expect(reasons({ ...validRecord(), url })).toContainEqual(
        expect.stringContaining("`url`"),
      );
    }
  });

  it("refuses a matchResult that is not JSON-safe", () => {
    expect(reasons({ ...validRecord(), matchResult: { at: new Date() } })).toContainEqual(
      expect.stringContaining("matchResult.at"),
    );
  });

  it("refuses a record carrying a `__proto__` key", () => {
    const hostile = JSON.parse('{"id":"job-1","title":"SWE","__proto__":{"admin":true}}') as unknown;
    expect(reasons(hostile)[0]).toMatch(/__proto__/);
  });
});

describe("validateJobRecord: out-of-union status is PRESERVED, not dropped or coerced", () => {
  // The decision, and why: `JobStatusPicker.jobStatusLabel` and `JobTracker`'s
  // bucketing both document that an unknown status must SURFACE rather than get
  // swallowed. Coercing to "interested" is that swallow; dropping the record
  // removes the one surface on which the user could repair it.
  it("keeps the raw value and warns", () => {
    const result = validateJobRecord({ ...validRecord(), status: "screening" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("screening");
    expect(result.warnings).toContainEqual(expect.stringContaining("screening"));
  });

  it("does not coerce it to `interested`", () => {
    const result = validateJobRecord({ ...validRecord(), status: "ghosted" });
    expect(result.ok && result.record.status).not.toBe("interested");
  });

  it("defaults an ABSENT status to `interested`, silently — it is a gap, not a value", () => {
    const result = validateJobRecord({ id: "job-1", title: "SWE" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("interested");
    expect(result.warnings).toEqual([]);
  });

  it("refuses a status that is not a string at all", () => {
    expect(reasons({ ...validRecord(), status: 3 })).toContainEqual(
      expect.stringContaining("`status`"),
    );
  });

  it("isKnownStatus reads the one lifecycle vocabulary", () => {
    expect(isKnownStatus("interviewing")).toBe(true);
    expect(isKnownStatus("screening")).toBe(false);
  });
});

describe("validateJobRecord: unknown extra keys are PRESERVED", () => {
  // Dropping them makes export → import → export lossy for a user who moves a
  // backup from a newer build to an older one and back.
  it("carries an unrecognised field onto the stored record", () => {
    const result = validateJobRecord({ ...validRecord(), salaryRange: "180-220k" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.record as unknown as Record<string, unknown>).salaryRange).toBe(
      "180-220k",
    );
  });

  it("still requires an extra key's value to be JSON-safe", () => {
    expect(reasons({ ...validRecord(), extra: { when: new Date() } })).toContainEqual(
      expect.stringContaining("record.extra.when"),
    );
  });

  it("does not resurrect a KNOWN field that failed its rule", () => {
    const result = validateJobRecord({ ...validRecord(), title: 42 });
    expect(result.ok).toBe(false);
  });
});

describe("validateJobRecord: a url that is not absolute is kept, with a warning", () => {
  // Backward compatibility, and a real distinction: `acme.com` is inert in an
  // `href` and is the user's own half-typed text; `javascript:` is executable.
  it("keeps it and warns", () => {
    const result = validateJobRecord({ ...validRecord(), url: "acme.com/jobs/1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.url).toBe("acme.com/jobs/1");
    expect(result.warnings).toContainEqual(expect.stringContaining("not an absolute URL"));
  });
});

describe("findJsonSafetyProblem", () => {
  it.each([
    ["undefined in an object", { a: undefined }, "value.a"],
    ["a function", { a: () => 1 }, "value.a"],
    ["NaN", { a: Number.NaN }, "value.a"],
    ["Infinity", { a: Number.POSITIVE_INFINITY }, "value.a"],
    ["a BigInt", { a: 1n }, "value.a"],
    ["a Date", { a: new Date() }, "value.a"],
    ["a Map", { a: new Map() }, "value.a"],
    ["a RegExp", { a: /x/ }, "value.a"],
    ["a nested array element", { a: [1, Number.NaN] }, "value.a[1]"],
  ])("refuses %s and names its path", (_label, value, path) => {
    expect(findJsonSafetyProblem(value, "value")?.path).toBe(path);
  });

  it("refuses a cycle rather than throwing the way JSON.stringify does", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(cyclic)).toThrow();
    expect(findJsonSafetyProblem(cyclic, "value")?.reason).toMatch(/circular/);
  });

  it("accepts a DAG — one object referenced twice is not a cycle", () => {
    const shared = { n: 1 };
    expect(findJsonSafetyProblem({ a: shared, b: shared }, "value")).toBeNull();
  });

  it("accepts every JSON primitive, including a null-prototype object", () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    expect(findJsonSafetyProblem({ n: 0, s: "", b: false, z: null, arr: [], o: bare }, "value"))
      .toBeNull();
  });

  it("refuses values JSON.parse(JSON.stringify(x)) would silently REWRITE", () => {
    // The reason the check isn't a round-trip: none of these throw, they mutate.
    const rewritten = JSON.parse(
      JSON.stringify({ n: Number.NaN, d: new Date(0), u: undefined }),
    ) as Record<string, unknown>;
    expect(rewritten.n).toBeNull();
    expect(typeof rewritten.d).toBe("string");
    expect("u" in rewritten).toBe(false);
    expect(findJsonSafetyProblem({ n: Number.NaN }, "value")).not.toBeNull();
  });
});

describe("drift guard: every declared rule actually rejects something", () => {
  // Iterates the rule map rather than a hand-written field list, so a field
  // added to `JobRecord` — which `tsc` forces into the map — is covered here
  // with no edit. A rule whose `check` were a no-op (`() => true`) fails this.
  it.each(Object.keys(JOB_RECORD_RULES))(
    "`%s` refuses a value no field type admits",
    (field) => {
      const result = validateJobRecord({ ...validRecord(), [field]: () => "nope" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasons.join(" ")).toContain(field);
    },
  );

  it("names every rule's expectation, so a refusal tells a producer what to send", () => {
    for (const [field, rule] of Object.entries(JOB_RECORD_RULES)) {
      expect(rule.expected, field).toMatch(/\S/);
    }
  });
});

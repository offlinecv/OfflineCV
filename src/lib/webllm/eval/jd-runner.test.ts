// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { JD_EVAL_FIXTURES, getJdEvalFixtureById } from "./jd-fixtures.ts";
import { runJdEval } from "./jd-runner.ts";
import type { JdMatchFn } from "./jd-types.ts";

/** The canned-output stub (#205): no model, no WebGPU — returns exactly the
 *  fixture's own `canned` result, the same "stub echoes the fixture" shape
 *  the rewrite harness's Node tests use. */
const STUB_MATCH_FN: JdMatchFn = async ({ fixture }) => fixture.canned;

describe("runJdEval", () => {
  it("runs the JD rubric against all 5 fixtures via the canned-output stub", async () => {
    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: JD_EVAL_FIXTURES,
      matchFn: STUB_MATCH_FN,
    });

    expect(report.fixtureIds).toEqual(JD_EVAL_FIXTURES.map((f) => f.id));
    expect(report.records).toHaveLength(JD_EVAL_FIXTURES.length);
    for (const record of report.records) {
      expect(record.error, record.fixtureId).toBeNull();
      expect(record.path, record.fixtureId).toBe("semantic");
      expect(record.rubric.jsonWellFormed, record.fixtureId).toBe(true);
      expect(record.rubric.noInventedRequirements, record.fixtureId).toBe(true);
      expect(record.rubric.statusShapeValid, record.fixtureId).toBe(true);
      expect(record.rubric.reasonsSane, record.fixtureId).toBe(true);
      expect(record.rubric.evidenceGrounded, record.fixtureId).toBe(true);
    }
  });

  it("computes the semantic-vs-keyword comparison for the software-engineer fixture", async () => {
    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: JD_EVAL_FIXTURES,
      matchFn: STUB_MATCH_FN,
    });

    // #205: reported, not gated — this only asserts the comparison computed a
    // value for BOTH arms, not that semantic actually beat keyword.
    const comparison = report.comparisons.find((c) => c.fixtureId === "software-engineer");
    expect(comparison).toBeDefined();
    expect(comparison?.semanticAgreementRate).toBeGreaterThanOrEqual(0);
    expect(comparison?.keywordCoverageRate).toBeGreaterThanOrEqual(0);
  });

  it("flags injectionSafe only on the prompt-injection fixture", async () => {
    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: JD_EVAL_FIXTURES,
      matchFn: STUB_MATCH_FN,
    });

    for (const record of report.records) {
      if (record.fixtureId === "prompt-injection") {
        expect(record.injectionSafe).toBe(true);
      } else {
        expect(record.injectionSafe).toBeNull();
      }
    }
  });

  it("scores the empty rubric and records the error when matchFn throws", async () => {
    const throwing: JdMatchFn = async () => {
      throw new Error("engine exploded");
    };
    const fixture = getJdEvalFixtureById("music-intern");
    if (!fixture) throw new Error("fixture not found");

    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: [fixture],
      matchFn: throwing,
    });

    expect(report.records).toHaveLength(1);
    expect(report.records[0].error).toBe("engine exploded");
    expect(report.records[0].rubric.jsonWellFormed).toBe(false);
    expect(report.comparisons).toEqual([]);
  });

  it("stamps startedAt from the injected clock", async () => {
    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: [],
      matchFn: STUB_MATCH_FN,
      now: () => 0,
    });
    expect(report.startedAt).toBe(new Date(0).toISOString());
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { renderJsonReport, renderMarkdownReport } from "./report.ts";
import type { EvalReport, RunRecord } from "./types.ts";

function passingRecord(modelId: string, variantId: string, fixtureId: string): RunRecord {
  return {
    modelId,
    variantId,
    fixtureId,
    fixtureKind: "weak",
    inputBulletCount: 5,
    outputBulletCount: 5,
    rubric: {
      numbersPreserved: true,
      oneLinePerBullet: true,
      actionVerbLead: true,
      lengthSanity: true,
      noPreambleLeak: true,
      dedupEffective: null,
      judgeCoherence: null,
      perBullet: [],
      droppedNumbers: [],
      addedNumbers: [],
    },
    rewriteDurationMs: 1200,
    error: null,
  };
}

const sampleReport: EvalReport = {
  startedAt: "2026-06-23T00:00:00.000Z",
  appVersion: "abc1234",
  modelIds: ["Qwen2.5-1.5B-Instruct-q4f16_1-MLC"],
  variantIds: ["baseline"],
  fixtureIds: ["fx-weak", "fx-strong"],
  judgeEnabled: false,
  records: [
    passingRecord("Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "baseline", "fx-weak"),
    passingRecord("Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "baseline", "fx-strong"),
  ],
  aggregates: [
    {
      modelId: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      variantId: "baseline",
      scoredFixtures: 2,
      numbersPreservedRate: 1,
      oneLineRate: 1,
      actionVerbRate: 1,
      lengthSanityRate: 1,
      noPreambleLeakRate: 1,
      dedupEffectiveRate: null,
      judgeMean: null,
      aggregateScore: 1,
    },
  ],
};

describe("renderJsonReport", () => {
  it("renders pretty-printed JSON with a trailing newline", () => {
    const out = renderJsonReport(sampleReport);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.startedAt).toBe("2026-06-23T00:00:00.000Z");
    expect(parsed.aggregates).toHaveLength(1);
  });
});

describe("renderMarkdownReport", () => {
  it("includes the header metadata", () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain("# Rewrite eval report");
    expect(md).toContain("**Started:** 2026-06-23T00:00:00.000Z");
    expect(md).toContain("**App version:** `abc1234`");
    expect(md).toContain("**LLM judge:** disabled (default)");
  });

  it("renders the aggregate table with model name resolved from the registry", () => {
    const md = renderMarkdownReport(sampleReport);
    // The model id resolves to its registry name via getModelById.
    expect(md).toContain("| Qwen 2.5 (1.5B) | Baseline (shipped) |");
    expect(md).toContain("**100%**");
  });

  it("renders `—` for dedup and judge when they don't apply", () => {
    const md = renderMarkdownReport(sampleReport);
    // The aggregate row's dedup + judge columns should render `—`.
    expect(md).toMatch(/\| — \| — \| \*\*100%\*\* \|/);
  });

  it("renders an error column for errored cells", () => {
    const errReport: EvalReport = {
      ...sampleReport,
      records: [
        {
          ...passingRecord("Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "baseline", "fx-weak"),
          error: "model OOM",
          outputBulletCount: 0,
          rubric: {
            ...passingRecord("M", "V", "F").rubric,
            numbersPreserved: false,
            actionVerbLead: false,
          },
        },
      ],
    };
    const md = renderMarkdownReport(errReport);
    expect(md).toContain("`model OOM`");
    expect(md).toContain("fail");
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { runEval } from "./runner.ts";
import type {
  FixtureKind,
  RawRewriteOutput,
  RewriteFixture,
  RewriteFn,
} from "./types.ts";

function fixture(id: string, kind: FixtureKind, bullets: string[]): RewriteFixture {
  return { id, kind, description: `fixture ${id}`, bullets };
}

/** Stable per-(model, variant, fixture) output dispatch for runner tests. */
function dispatchFn(
  table: Record<string, RawRewriteOutput | Error>,
): RewriteFn {
  return async ({ modelId, variantId, fixture: f }) => {
    const key = `${modelId}|${variantId}|${f.id}`;
    const v = table[key];
    if (!v) throw new Error(`no canned output for ${key}`);
    if (v instanceof Error) throw v;
    return v;
  };
}

describe("runEval", () => {
  it("iterates (model × variant × fixture) and emits one record per cell", async () => {
    const fx1 = fixture("f1", "weak", ["Worked on stuff."]);
    const fx2 = fixture("f2", "strong", ["Built X."]);
    const goodOut: RawRewriteOutput = {
      bullets: ["Drove a 4-touchpoint nurture sequence lifting MQL 12% across 3 channels."],
      raw: "Drove a 4-touchpoint nurture sequence lifting MQL 12% across 3 channels.",
    };

    const table: Record<string, RawRewriteOutput> = {};
    for (const m of ["M-A", "M-B"]) {
      for (const v of ["V-baseline", "V-terse"]) {
        for (const f of [fx1, fx2]) {
          table[`${m}|${v}|${f.id}`] = goodOut;
        }
      }
    }

    const report = await runEval({
      modelIds: ["M-A", "M-B"],
      variantIds: ["V-baseline", "V-terse"],
      fixtures: [fx1, fx2],
      rewriteFn: dispatchFn(table),
    });

    expect(report.records).toHaveLength(2 * 2 * 2);
    expect(report.aggregates).toHaveLength(2 * 2);
    // Order: M-A × V-baseline × (fx1, fx2), then M-A × V-terse × ...
    expect(report.records[0]).toMatchObject({
      modelId: "M-A",
      variantId: "V-baseline",
      fixtureId: "f1",
    });
    expect(report.records[7]).toMatchObject({
      modelId: "M-B",
      variantId: "V-terse",
      fixtureId: "f2",
    });
  });

  it("records error rows without aborting the run, scoring them 0", async () => {
    const fx1 = fixture("f1", "weak", ["Worked on stuff."]);
    const fx2 = fixture("f2", "strong", ["Built X."]);
    const good: RawRewriteOutput = {
      bullets: ["Drove a 4-touchpoint nurture sequence lifting MQL 12% across 3 channels."],
      raw: "Drove a 4-touchpoint nurture sequence lifting MQL 12% across 3 channels.",
    };

    const table = {
      "M-A|V-baseline|f1": good,
      "M-A|V-baseline|f2": new Error("model OOM"),
    };

    const report = await runEval({
      modelIds: ["M-A"],
      variantIds: ["V-baseline"],
      fixtures: [fx1, fx2],
      rewriteFn: dispatchFn(table),
    });

    expect(report.records).toHaveLength(2);
    expect(report.records[1].error).toBe("model OOM");
    expect(report.records[1].rubric.actionVerbLead).toBe(false);

    // The aggregate counts the error row OUT of `scoredFixtures` but
    // still computes rates over scored ones only.
    expect(report.aggregates[0].scoredFixtures).toBe(1);
    expect(report.aggregates[0].actionVerbRate).toBe(1);
  });

  it("computes a dedup rate over redundant fixtures only", async () => {
    const fxRed = fixture("r", "redundant", ["A", "B", "C"]);
    const fxStr = fixture("s", "strong", ["X"]);
    const dedupedOk: RawRewriteOutput = {
      bullets: ["Triaged 200+ inbound support tickets weekly across email and chat."],
      raw: "",
    };
    const noChange: RawRewriteOutput = {
      bullets: ["Built X across 3 teams to scale operations across the org."],
      raw: "",
    };

    const report = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fxRed, fxStr],
      rewriteFn: dispatchFn({
        "M|V|r": dedupedOk,
        "M|V|s": noChange,
      }),
    });

    expect(report.aggregates[0].dedupEffectiveRate).toBe(1);

    // A run with no redundant fixtures yields null, not 0.
    const reportNoRed = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fxStr],
      rewriteFn: dispatchFn({ "M|V|s": noChange }),
    });
    expect(reportNoRed.aggregates[0].dedupEffectiveRate).toBeNull();
  });

  it("threads modelIds / variantIds / judgeEnabled into the report header", async () => {
    const fx = fixture("f", "weak", ["W"]);
    const r = await runEval({
      modelIds: ["M-A"],
      variantIds: ["V-1"],
      fixtures: [fx],
      rewriteFn: dispatchFn({
        "M-A|V-1|f": { bullets: ["Drove a 4-touchpoint nurture sequence lifting MQL 12% across 3 channels."], raw: "" },
      }),
      judgeEnabled: true,
      appVersion: "abc1234",
      now: () => 1735689600000, // 2025-01-01T00:00:00Z
    });
    expect(r.judgeEnabled).toBe(true);
    expect(r.appVersion).toBe("abc1234");
    expect(r.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(r.modelIds).toEqual(["M-A"]);
    expect(r.variantIds).toEqual(["V-1"]);
    expect(r.fixtureIds).toEqual(["f"]);
  });

  it("carries the #778 revert flag onto the record and into revertedRate", async () => {
    // The harness runs the product's reject gate before scoring, so a reverted
    // cell arrives already scoring `numbersPreserved: true` — the input IS the
    // output. `revertedRate` is what keeps that from reading as a model that
    // preserved everything on its own.
    const fx = fixture("numeric", "numeric", ["Grew ARR to $4.2M in FY24."]);
    const clean = fixture("clean", "strong", [
      "Owned the write path end to end.",
    ]);
    const report = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fx, clean],
      rewriteFn: dispatchFn({
        "M|V|numeric": {
          bullets: ["Grew ARR to $4.2M in FY24."],
          raw: "Grew ARR substantially.",
          reverted: true,
          revertedNumbers: ["$4.2M"],
        },
        "M|V|clean": {
          bullets: ["Owned the write path end to end."],
          raw: "Owned the write path end to end.",
        },
      }),
    });
    const reverted = report.records.find((r) => r.fixtureId === "numeric")!;
    expect(reverted.reverted).toBe(true);
    expect(reverted.revertedNumbers).toEqual(["$4.2M"]);
    expect(reverted.rubric.numbersPreserved).toBe(true);
    expect(report.records.find((r) => r.fixtureId === "clean")!.reverted).toBe(
      false,
    );
    expect(report.aggregates[0]!.revertedRate).toBe(0.5);
    expect(report.aggregates[0]!.numbersPreservedRate).toBe(1);
  });

  it("keeps revertedRate out of the composite aggregateScore", async () => {
    // A revert is the guardrail working, so scoring it as a criterion in
    // either direction would misstate the run the default model is picked from.
    const fx = fixture("f", "strong", ["Cut p99 latency 40% on the write path."]);
    const output: RawRewriteOutput = {
      bullets: ["Cut p99 latency 40% on the write path."],
      raw: "Cut p99 latency 40% on the write path.",
      reverted: true,
      revertedNumbers: ["40%"],
    };
    const withRevert = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fx],
      rewriteFn: dispatchFn({ "M|V|f": output }),
    });
    const withoutRevert = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fx],
      rewriteFn: dispatchFn({
        "M|V|f": { bullets: output.bullets, raw: output.raw },
      }),
    });
    expect(withRevert.aggregates[0]!.revertedRate).toBe(1);
    expect(withoutRevert.aggregates[0]!.revertedRate).toBe(0);
    expect(withRevert.aggregates[0]!.aggregateScore).toBe(
      withoutRevert.aggregates[0]!.aggregateScore,
    );
  });

  it("keeps numbersPreservedRate out of the composite aggregateScore too", async () => {
    // Post-#778 the gate makes this rate ~1.0 for every model, so leaving it in
    // the composite added a constant term to every row and displaced a
    // criterion that actually discriminates. Same treatment as `revertedRate`.
    const fx = fixture("f", "strong", ["Cut p99 latency 40% on the write path."]);
    const preserved = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fx],
      rewriteFn: dispatchFn({
        "M|V|f": {
          bullets: ["Cut p99 latency 40% on the write path."],
          raw: "Cut p99 latency 40% on the write path.",
        },
      }),
    });
    const dropped = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fx],
      rewriteFn: dispatchFn({
        "M|V|f": {
          bullets: ["Cut p99 latency on the write path."],
          raw: "Cut p99 latency on the write path.",
        },
      }),
    });
    expect(preserved.aggregates[0]!.numbersPreservedRate).toBe(1);
    expect(dropped.aggregates[0]!.numbersPreservedRate).toBe(0);
    // Still reported in the row — only its contribution to the score is gone.
    expect(dropped.aggregates[0]!.aggregateScore).toBe(
      preserved.aggregates[0]!.aggregateScore,
    );
  });

  it("defaults reverted to false for a stub that never ran the gate", async () => {
    const fx = fixture("f", "weak", ["W"]);
    const report = await runEval({
      modelIds: ["M"],
      variantIds: ["V"],
      fixtures: [fx],
      rewriteFn: dispatchFn({
        "M|V|f": { bullets: ["Owned the write path end to end."], raw: "" },
      }),
    });
    expect(report.records[0]!.reverted).toBe(false);
    expect(report.records[0]!.revertedNumbers).toEqual([]);
  });

  it("invokes onProgress once per cell with running counts", async () => {
    const fx = fixture("f", "weak", ["W"]);
    const good: RawRewriteOutput = {
      bullets: ["Drove a 4-touchpoint nurture sequence lifting MQL 12% across 3 channels."],
      raw: "",
    };
    const progress: Array<[number, number, string]> = [];
    await runEval({
      modelIds: ["M-A", "M-B"],
      variantIds: ["V"],
      fixtures: [fx],
      rewriteFn: dispatchFn({ "M-A|V|f": good, "M-B|V|f": good }),
      onProgress: (done, total, cell) => {
        progress.push([done, total, cell.modelId]);
      },
    });
    expect(progress).toEqual([
      [1, 2, "M-A"],
      [2, 2, "M-B"],
    ]);
  });
});

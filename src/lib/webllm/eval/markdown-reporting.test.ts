// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * End-to-end wiring for the `noResidualMarkdown` column (#805).
 *
 * `rubric.test.ts` proves `scoreRubric` populates the criterion correctly.
 * This file proves the path that actually produces the number a human
 * reads: fixture → `runEval` → `RunRecord` → `AggregateRow` → the Markdown
 * table — the same gap `adherence-reporting.test.ts` closed for
 * `steeringAdherence` (#608 half 2).
 *
 * Unlike `steeringAdherence`, this criterion is never `null` — every record
 * is scored, so a wiring break here cannot hide behind an em dash the way a
 * dropped `steering` field could. The risk this file guards against instead
 * is the composite: `noResidualMarkdownRate` has to actually land inside
 * `deterministicRates` in `runner.ts`, or a model that ships literal `**` in
 * every bullet would still score a perfect `Aggregate`.
 *
 * Everything here runs on a stub `RewriteFn`. No model, no WebGPU.
 */

import { describe, expect, it } from "vitest";
import { runEval } from "./runner.ts";
import { renderMarkdownReport } from "./report.ts";
import { aggregateTable, splitRow } from "./__test-utils__/aggregate-table.ts";
import type { RewriteFixture, RewriteFn } from "./types.ts";

const MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const VARIANT = "shipped";

const FIXTURE: RewriteFixture = {
  id: "markdown-probe",
  kind: "weak",
  description: "Probes for literal markdown surviving cleanup.",
  bullets: ["Led the migration of the billing platform."],
};

function stubReturning(bullets: readonly string[]): RewriteFn {
  return async () => ({ bullets, raw: bullets.join("\n") });
}

async function runOne(rewriteFn: RewriteFn) {
  return runEval({
    modelIds: [MODEL],
    variantIds: [VARIANT],
    fixtures: [FIXTURE],
    rewriteFn,
    now: () => 0,
  });
}

describe("runEval populates noResidualMarkdown on the record", () => {
  it("is TRUE when the stub's output is clean", async () => {
    const report = await runOne(
      stubReturning([
        "Led the migration of the billing platform across 12 regional markets.",
      ]),
    );
    expect(report.records[0]!.rubric.noResidualMarkdown).toBe(true);
  });

  it("is FALSE when the stub's output carries a paired bold span (#781's regression)", async () => {
    const report = await runOne(
      stubReturning([
        "**Led** the migration of the billing platform across 12 regional markets.",
      ]),
    );
    expect(report.records[0]!.rubric.noResidualMarkdown).toBe(false);
  });
});

describe("the aggregate rate and composite", () => {
  it("is 1 when every scored cell is clean", async () => {
    const report = await runOne(
      stubReturning(["Led the migration across 12 regional markets."]),
    );
    expect(report.aggregates[0]!.noResidualMarkdownRate).toBe(1);
  });

  it("is 0 when the only cell carries residual markdown", async () => {
    const report = await runOne(
      stubReturning(["**Led** the migration across 12 regional markets."]),
    );
    expect(report.aggregates[0]!.noResidualMarkdownRate).toBe(0);
  });

  it("pulls the composite aggregateScore down — the whole point of #805", async () => {
    // The two outputs differ in exactly the markdown wrapping, so any
    // composite delta is attributable to this criterion alone.
    const clean = await runOne(
      stubReturning(["Led the migration across 12 regional markets."]),
    );
    const markdown = await runOne(
      stubReturning(["**Led** the migration across 12 regional markets."]),
    );
    expect(markdown.aggregates[0]!.aggregateScore).toBeLessThan(
      clean.aggregates[0]!.aggregateScore,
    );
  });
});

describe("the Markdown report renders the number a human reads", () => {
  it("has a No-markdown column whose separator row matches the header", async () => {
    const table = aggregateTable(
      renderMarkdownReport(
        await runOne(stubReturning(["**Led** the migration."])),
      ),
    );
    expect(splitRow(table.header)).toContain("No-markdown");
    expect(table.separator.split("|").length).toBe(
      table.header.split("|").length,
    );
  });

  it("shows 0% in the No-markdown cell for a run that caught it, not a silent 100%", async () => {
    const table = aggregateTable(
      renderMarkdownReport(
        await runOne(
          stubReturning(["**Led** the migration across 12 regional markets."]),
        ),
      ),
    );
    expect(table.cell("No-markdown")).toBe("0%");
  });

  it("shows 100% in the No-markdown cell for a clean run", async () => {
    const table = aggregateTable(
      renderMarkdownReport(
        await runOne(
          stubReturning(["Led the migration across 12 regional markets."]),
        ),
      ),
    );
    expect(table.cell("No-markdown")).toBe("100%");
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * End-to-end wiring for the steering-adherence column (#608 half 2).
 *
 * `adherence.test.ts` proves the SCORER bites and `rubric.test.ts` proves
 * `scoreRubric` populates the criterion. Neither covers the path that actually
 * produces the number a human reads: fixture → `runEval` → `RunRecord` →
 * `AggregateRow` → the Markdown table. Before this file, every runner and
 * report test set `steeringAdherence` / `steeringAdherenceRate` to `null`, so a
 * break anywhere along that path would have surfaced as a `—` in every Steering
 * cell of a committed report.
 *
 * That failure mode is expensive in a way a normal test gap is not. The
 * inference leg is browser-only and one model per tab, so the run it would
 * silently invalidate is a multi-model, multi-gigabyte manual session — and the
 * `—` reads as "this fixture doesn't probe steering", not as "the harness is
 * broken". #608's own rule was to prove the scorer bites before trusting its
 * verdict; this is the same argument one level up, about the instrument that
 * reports it.
 *
 * Everything here runs on a stub `RewriteFn`. No model, no WebGPU — the point
 * is the plumbing, not the adherence of any real model.
 */

import { describe, expect, it } from "vitest";
import { runEval } from "./runner.ts";
import { renderMarkdownReport } from "./report.ts";
import { REWRITE_FIXTURES, getFixtureById } from "./fixtures.ts";
import type { RewriteFn, RewriteFixture } from "./types.ts";

const MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const VARIANT = "shipped";

/** The committed probe fixture — the one a real run measures half 2 with. */
const STEERING_FIXTURE = getFixtureById("steering-forbidden-word");

/** A stub that returns `bullets` verbatim for every cell. */
function stubReturning(bullets: readonly string[]): RewriteFn {
  return async () => ({ bullets, raw: bullets.join("\n") });
}

/** Echo the fixture's own input back — the "model ignored the instruction"
 *  case for the forbidden-word probe, since every input bullet contains it. */
const echoInput: RewriteFn = async ({ fixture }) => ({
  bullets: fixture.bullets,
  raw: fixture.bullets.join("\n"),
});

async function runOne(fixture: RewriteFixture, rewriteFn: RewriteFn) {
  return runEval({
    modelIds: [MODEL],
    variantIds: [VARIANT],
    fixtures: [fixture],
    rewriteFn,
    now: () => 0,
  });
}

/** `| a | b |` → `["", "a", "b", ""]`. Header and row split identically, so
 *  a column's index in one is its cell's index in the other. */
function splitRow(line: string): string[] {
  return line.split("|").map((c) => c.trim());
}

/**
 * The aggregate table, addressed BY COLUMN NAME.
 *
 * Matching a whole rendered row against a substring is what made the first
 * version of the two tests below unfalsifiable (#714 review): every other cell
 * in this run's row is `100%`, and `100%` contains `0%`, so a row whose
 * Steering cell had silently become `—` still matched `/0\.0%|0%/`. And `—`
 * appears in the Judge and Dedup cells of every report the judge is disabled
 * for — the default here — so `md.toContain("—")` was true of the probed report
 * too, i.e. of the exact output the sibling test says must NOT show one.
 *
 * Selecting the cell by its header index is the smallest fix that discriminates,
 * and it survives a column reorder in `report.ts` for free.
 *
 * `headerIdx + 2` is the first data row: `renderMarkdownReport` emits header,
 * separator, then one row per model × variant, and every run in this file is a
 * single model and a single variant.
 */
function aggregateTable(md: string): {
  header: string;
  separator: string;
  row: string;
  cell: (column: string) => string;
} {
  const lines = md.split("\n");
  const headerIdx = lines.findIndex((l) => l.startsWith("| Model | Variant |"));
  if (headerIdx < 0) throw new Error(`no aggregate table in report:\n${md}`);
  const header = lines[headerIdx]!;
  const row = lines[headerIdx + 2]!;
  const columns = splitRow(header);
  const cells = splitRow(row);
  return {
    header,
    separator: lines[headerIdx + 1]!,
    row,
    cell: (column) => {
      const i = columns.indexOf(column);
      if (i < 0) throw new Error(`no "${column}" column in: ${header}`);
      return cells[i]!;
    },
  };
}

describe("the steering fixture is actually shipped", () => {
  it("is registered in REWRITE_FIXTURES and carries a probe", () => {
    // If the fixture is dropped from the registry, every assertion below still
    // passes on a hand-built object while a real run measures nothing.
    // `getFixtureById` IS `REWRITE_FIXTURES.find(...)` (`fixtures.ts:154`), so
    // these two assertions already say "a registry fixture carries a probe" —
    // a third `REWRITE_FIXTURES.some(f => f.steering)` read as an independent
    // guarantee while being the same one (#714 review).
    expect(STEERING_FIXTURE).toBeDefined();
    expect(STEERING_FIXTURE!.steering?.check).toEqual({
      kind: "forbidden-word",
      word: "spearheaded",
    });
  });
});

describe("runEval populates steeringAdherence on the record", () => {
  it("is TRUE when the stub obeyed the instruction", async () => {
    const report = await runOne(
      STEERING_FIXTURE!,
      stubReturning([
        "Led the billing platform migration across 12 regional markets",
        "Cut scope churn 30% with a quarterly planning process",
      ]),
    );
    expect(report.records[0]!.rubric.steeringAdherence).toBe(true);
  });

  it("is FALSE when the stub echoed the forbidden word back", async () => {
    // The fixture's inputs all lead with "Spearheaded", so echoing them is
    // exactly the non-compliance the probe exists to detect.
    const report = await runOne(STEERING_FIXTURE!, echoInput);
    expect(report.records[0]!.rubric.steeringAdherence).toBe(false);
  });

  it("stays NULL for a fixture with no probe, leaving other fixtures alone", async () => {
    const plain = REWRITE_FIXTURES.find((f) => f.steering === undefined);
    expect(plain).toBeDefined();
    const report = await runOne(plain!, stubReturning(["Led the migration"]));
    expect(report.records[0]!.rubric.steeringAdherence).toBeNull();
  });
});

describe("the aggregate computes a real rate, not null", () => {
  it("is 0 when the only probe fixture failed", async () => {
    const report = await runOne(STEERING_FIXTURE!, echoInput);
    expect(report.aggregates[0]!.steeringAdherenceRate).toBe(0);
  });

  it("is 1 when it passed", async () => {
    const report = await runOne(
      STEERING_FIXTURE!,
      stubReturning(["Led the billing platform migration across 12 markets"]),
    );
    expect(report.aggregates[0]!.steeringAdherenceRate).toBe(1);
  });

  it("is null — not 0 — when no fixture in the run probes steering", async () => {
    // The distinction the report renders as `—`. Scoring an un-probed run as 0
    // would drag the composite down and read as "the model ignored everything".
    const plain = REWRITE_FIXTURES.find((f) => f.steering === undefined);
    const report = await runOne(plain!, stubReturning(["Led the migration"]));
    expect(report.aggregates[0]!.steeringAdherenceRate).toBeNull();
  });

  it("counts toward the composite aggregateScore when present", async () => {
    // The two outputs differ in EXACTLY one token — the forbidden word — so
    // every other criterion (numbers, one-line, verb-lead, length, preamble)
    // scores identically and any composite delta is attributable to adherence
    // alone. An earlier version of this test compared two differently-shaped
    // outputs and they happened to tie, which proved nothing in either
    // direction.
    const TAIL = " the billing migration across 12 markets, cutting churn 30%";
    const passed = await runOne(
      STEERING_FIXTURE!,
      stubReturning([`Led${TAIL}`]),
    );
    const failed = await runOne(
      STEERING_FIXTURE!,
      stubReturning([`Spearheaded${TAIL}`]),
    );

    const [p] = passed.aggregates;
    const [f] = failed.aggregates;
    // Pin the isolation rather than assuming it: every other rate is equal.
    expect(p!.numbersPreservedRate).toBe(f!.numbersPreservedRate);
    expect(p!.oneLineRate).toBe(f!.oneLineRate);
    expect(p!.actionVerbRate).toBe(f!.actionVerbRate);
    expect(p!.lengthSanityRate).toBe(f!.lengthSanityRate);
    expect(p!.noPreambleLeakRate).toBe(f!.noPreambleLeakRate);

    expect(p!.steeringAdherenceRate).toBe(1);
    expect(f!.steeringAdherenceRate).toBe(0);
    expect(p!.aggregateScore).toBeGreaterThan(f!.aggregateScore);
  });
});

describe("the Markdown report renders the number a human reads", () => {
  it("has a Steering column whose separator row matches the header", async () => {
    const table = aggregateTable(
      renderMarkdownReport(await runOne(STEERING_FIXTURE!, echoInput)),
    );
    expect(splitRow(table.header)).toContain("Steering");
    // A short separator silently collapses the table in some renderers, which
    // is how a column goes missing from a committed report without failing.
    expect(table.separator.split("|").length).toBe(
      table.header.split("|").length,
    );
  });

  it("shows a percentage in the STEERING cell for a probed run, not an em dash", async () => {
    const table = aggregateTable(
      renderMarkdownReport(await runOne(STEERING_FIXTURE!, echoInput)),
    );
    // The one assertion this whole file exists for. `—` here would read as
    // "this fixture doesn't probe steering" on a run that did probe — and it is
    // what a break anywhere along fixture → runEval → aggregate → table would
    // render. Asserted on the CELL, not the row: the row's other cells are all
    // `100%`, and `100%` contains `0%` (#714 review).
    expect(table.cell("Steering")).toBe("0%");
  });

  it("still shows an em dash in the STEERING cell for a run with no probe", async () => {
    const plain = REWRITE_FIXTURES.find((f) => f.steering === undefined);
    const table = aggregateTable(
      renderMarkdownReport(
        await runOne(plain!, stubReturning(["Led the migration"])),
      ),
    );
    // Also the cell, not the document: `numOrDash(judgeMean)` puts an em dash in
    // the Judge column of every report run with the judge disabled — which is
    // every report here — so `toContain("—")` was true of the probed report too.
    expect(table.cell("Steering")).toBe("—");
  });
});

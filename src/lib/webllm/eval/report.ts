// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { getModelById } from "../models.ts";
import { getVariantById } from "./prompt-variants.ts";
import type { EvalReport } from "./types.ts";

/**
 * Render the eval report in two flavors:
 *
 *   - `renderJsonReport` — stable structured artifact (committed under
 *     `tests/fixtures/rewrite/reports/`). Machine-diffable across runs.
 *   - `renderMarkdownReport` — human-readable table for PR / issue
 *     comments. Same shape as the JSON; just the prose layer.
 *
 * The renderer is pure over `EvalReport` so a snapshot test fixes the
 * formatting against drift. Reports are intentionally lossy on
 * model-output text (per-bullet text is included but per-cell raw
 * responses are not) so the artifact stays under a kilobyte per cell.
 */

export function renderJsonReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdownReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("# Rewrite eval report");
  lines.push("");
  lines.push(`- **Started:** ${report.startedAt}`);
  if (report.appVersion) lines.push(`- **App version:** \`${report.appVersion}\``);
  lines.push(`- **Models:** ${report.modelIds.length}`);
  lines.push(`- **Prompt variants:** ${report.variantIds.length}`);
  lines.push(`- **Fixtures:** ${report.fixtureIds.length}`);
  lines.push(
    `- **LLM judge:** ${report.judgeEnabled ? "enabled" : "disabled (default)"}`,
  );
  lines.push("");

  lines.push("## Aggregate (per model × variant)");
  lines.push("");
  lines.push(
    "| Model | Variant | Numbers | One-line | Verb | Length | No-preamble | Dedup | Judge | **Aggregate** |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of report.aggregates) {
    const modelLabel = getModelById(row.modelId)?.name ?? row.modelId;
    const variantLabel = getVariantById(row.variantId)?.label ?? row.variantId;
    lines.push(
      `| ${modelLabel} | ${variantLabel} | ${pct(row.numbersPreservedRate)} | ${pct(row.oneLineRate)} | ${pct(row.actionVerbRate)} | ${pct(row.lengthSanityRate)} | ${pct(row.noPreambleLeakRate)} | ${pctOrDash(row.dedupEffectiveRate)} | ${numOrDash(row.judgeMean)} | **${pct(row.aggregateScore)}** |`,
    );
  }
  lines.push("");

  lines.push("## Per-cell records");
  lines.push("");
  for (const modelId of report.modelIds) {
    const modelLabel = getModelById(modelId)?.name ?? modelId;
    lines.push(`### ${modelLabel}`);
    lines.push("");
    for (const variantId of report.variantIds) {
      const variantLabel = getVariantById(variantId)?.label ?? variantId;
      lines.push(`#### ${variantLabel}`);
      lines.push("");
      lines.push(
        "| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |",
      );
      lines.push(
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const r of report.records) {
        if (r.modelId !== modelId || r.variantId !== variantId) continue;
        lines.push(
          `| ${r.fixtureId} | ${r.fixtureKind} | ${r.inputBulletCount} → ${r.outputBulletCount} | ${tick(r.rubric.numbersPreserved)} | ${tick(r.rubric.actionVerbLead)} | ${tick(r.rubric.lengthSanity)} | ${tick(r.rubric.noPreambleLeak)} | ${tickOrDash(r.rubric.dedupEffective)} | ${r.error ? `\`${r.error}\`` : ""} |`,
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function pctOrDash(v: number | null): string {
  return v === null ? "—" : pct(v);
}

function numOrDash(v: number | null): string {
  return v === null ? "—" : v.toFixed(2);
}

function tick(v: boolean): string {
  return v ? "PASS" : "fail";
}

function tickOrDash(v: boolean | null): string {
  return v === null ? "—" : tick(v);
}

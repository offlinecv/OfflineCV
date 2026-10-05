// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { findEvalModel } from "./candidate-models.ts";
import { pct, renderJsonReport, tick, tickOrDash } from "./report.ts";
import type { JdEvalReport } from "./jd-runner.ts";

/**
 * Render a `JdEvalReport` in the same two flavors the rewrite harness uses:
 * JSON (via the generalized `renderJsonReport` in `report.ts` — nothing
 * about JSON-stringifying a report is specific to the rewrite rubric, so
 * this re-exports rather than forking it) and Markdown (this file's own
 * `renderJdMarkdownReport`, since the table COLUMNS are the JD rubric's, not
 * the rewrite rubric's — but the per-cell formatters (`pct`/`tick`/
 * `tickOrDash`) are shape-agnostic, so they're imported rather than forked).
 */

export { renderJsonReport };

export function renderJdMarkdownReport(report: JdEvalReport): string {
  const lines: string[] = [];
  lines.push("# JD-match eval report");
  lines.push("");
  lines.push(`- **Started:** ${report.startedAt}`);
  if (report.appVersion) lines.push(`- **App version:** \`${report.appVersion}\``);
  lines.push(`- **Models:** ${report.modelIds.length}`);
  lines.push(`- **Fixtures:** ${report.fixtureIds.length}`);
  lines.push("");

  lines.push("## Per-cell records");
  lines.push("");
  for (const modelId of report.modelIds) {
    const modelLabel = findEvalModel(modelId)?.name ?? modelId;
    lines.push(`### ${modelLabel}`);
    lines.push("");
    lines.push(
      "| Fixture | Path | JSON | No invented | Status | Reasons | Evidence | Gold agreement | Injection-safe | Error |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of report.records) {
      if (r.modelId !== modelId) continue;
      lines.push(
        `| ${r.fixtureId} | ${r.path} | ${tick(r.rubric.jsonWellFormed)} | ${tick(r.rubric.noInventedRequirements)} | ${tick(r.rubric.statusShapeValid)} | ${tick(r.rubric.reasonsSane)} | ${tick(r.rubric.evidenceGrounded)} | ${pct(r.rubric.goldAgreement.agreementRate)} | ${tickOrDash(r.injectionSafe)} | ${r.error ? `\`${r.error}\`` : ""} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Semantic vs. keyword (reported, not gated)");
  lines.push("");
  lines.push("| Fixture | Semantic gold agreement | Keyword coverage |");
  lines.push("| --- | --- | --- |");
  for (const c of report.comparisons) {
    lines.push(`| ${c.fixtureId} | ${pct(c.semanticAgreementRate)} | ${pct(c.keywordCoverageRate)} |`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

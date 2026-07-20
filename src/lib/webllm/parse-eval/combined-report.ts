// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Report renderers for the separate-vs-combined comparison eval (issue #262).
 *
 * Mirrors `./report.ts` in shape (JSON + Markdown), but emits a side-by-side
 * comparison so the reviewer can read parse-accuracy deltas and critique
 * structural divergence at a glance. The Markdown table is the artifact the
 * PR description quotes to satisfy the #262 quality-measurement AC.
 *
 * Pure over `CombinedEvalReport` — no side effects.
 */

import type {
  CombinedEvalReport,
  CombinedFixtureComparison,
} from "./combined-score.ts";

export function renderCombinedJsonReport(report: CombinedEvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Signed delta string (positive deltas are good for accuracy, but the caller
 * decides — this function just formats). Returns "0pp" when equal so the
 * reviewer can scan for non-zero deltas.
 */
function deltaPp(combined: number, separate: number): string {
  const d = Math.round((combined - separate) * 100);
  if (d === 0) return "0pp";
  return d > 0 ? `+${d}pp` : `${d}pp`;
}

function deltaCount(combined: number, separate: number): string {
  const d = combined - separate;
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `${d}`;
}

function tick(v: boolean): string {
  return v ? "PASS" : "fail";
}

export function renderCombinedMarkdownReport(report: CombinedEvalReport): string {
  const { separateMeans: sM, combinedMeans: cM } = report;
  const { separateCritiqueMeans: sC, combinedCritiqueMeans: cC } = report;

  const lines: string[] = [];

  lines.push("# Combined-pass eval report (issue #262)");
  lines.push("");
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push(`- **Model:** \`${report.modelId}\``);
  lines.push(`- **Fixtures:** ${report.fixtures.length}`);
  lines.push("");
  lines.push(
    "Compares the SEPARATE pass (`parseResumeWithLlm` + `critiqueResumeWithLlm`)",
  );
  lines.push(
    "against the COMBINED pass (`analyzeResumeWithLlm`) on the same on-device",
  );
  lines.push("model. The `delta` column is `combined − separate`. Positive parse");
  lines.push("deltas are improvements; large absolute deltas are the red flag.");
  lines.push("");

  // ── Parse-accuracy means ──
  lines.push("## Parse accuracy (mean across fixtures)");
  lines.push("");
  lines.push("| Metric | Separate | Combined | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| Valid-JSON rate | ${pct(sM.validJsonRate)} | ${pct(cM.validJsonRate)} | ${deltaPp(cM.validJsonRate, sM.validJsonRate)} |`,
  );
  lines.push(
    `| Scalar accuracy | ${pct(sM.scalarAccuracy)} | ${pct(cM.scalarAccuracy)} | ${deltaPp(cM.scalarAccuracy, sM.scalarAccuracy)} |`,
  );
  lines.push(
    `| Skills accuracy | ${pct(sM.skillsAccuracy)} | ${pct(cM.skillsAccuracy)} | ${deltaPp(cM.skillsAccuracy, sM.skillsAccuracy)} |`,
  );
  lines.push(
    `| Experience accuracy | ${pct(sM.experienceAccuracy)} | ${pct(cM.experienceAccuracy)} | ${deltaPp(cM.experienceAccuracy, sM.experienceAccuracy)} |`,
  );
  lines.push(
    `| Education accuracy | ${pct(sM.educationAccuracy)} | ${pct(cM.educationAccuracy)} | ${deltaPp(cM.educationAccuracy, sM.educationAccuracy)} |`,
  );
  lines.push("");

  // ── Critique structural means ──
  lines.push("## Critique structure (mean across fixtures, no ground truth)");
  lines.push("");
  lines.push(
    "No fixture has ground truth for critique quality (small-model judgment is",
  );
  lines.push(
    "subjective). These are counts only — a large divergence between the two",
  );
  lines.push("passes is the red flag.");
  lines.push("");
  lines.push("| Metric | Separate | Combined | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| Bullets judged | ${sC.bulletCount.toFixed(1)} | ${cC.bulletCount.toFixed(1)} | ${deltaCount(cC.bulletCount, sC.bulletCount)} |`,
  );
  lines.push(
    `| Bullets flagged | ${sC.flaggedCount.toFixed(1)} | ${cC.flaggedCount.toFixed(1)} | ${deltaCount(cC.flaggedCount, sC.flaggedCount)} |`,
  );
  lines.push(
    `| Missing sections | ${sC.missingSectionCount.toFixed(1)} | ${cC.missingSectionCount.toFixed(1)} | ${deltaCount(cC.missingSectionCount, sC.missingSectionCount)} |`,
  );
  lines.push("");

  // ── Per-fixture parse table ──
  lines.push("## Per-fixture parse accuracy");
  lines.push("");
  lines.push(
    "| Fixture | Pass | valid-JSON | scalar | skills | exp | edu |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const f of report.fixtures) {
    lines.push(...renderFixtureParseRows(f));
  }
  lines.push("");

  // ── Per-fixture critique table ──
  lines.push("## Per-fixture critique structure");
  lines.push("");
  lines.push(
    "| Fixture | Pass | Bullets | Flagged | NoQuant | WeakVerb | Vague | Missing sections | Summary feedback |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const f of report.fixtures) {
    lines.push(...renderFixtureCritiqueRows(f));
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(
    "_Generated by the combined-pass eval harness. Paste into PR #262 description._",
  );
  lines.push("");

  return lines.join("\n");
}

function renderFixtureParseRows(f: CombinedFixtureComparison): string[] {
  const s = f.separate.parse;
  const c = f.combined.parse;
  return [
    `| ${f.fixtureLabel} | separate | ${tick(s.validJson)} | ${pct(s.scalarAccuracy)} | ${pct(s.skillsAccuracy)} | ${pct(s.experienceAccuracy)} | ${pct(s.educationAccuracy)} |`,
    `| ${f.fixtureLabel} | combined | ${tick(c.validJson)} | ${pct(c.scalarAccuracy)} | ${pct(c.skillsAccuracy)} | ${pct(c.experienceAccuracy)} | ${pct(c.educationAccuracy)} |`,
  ];
}

function renderFixtureCritiqueRows(f: CombinedFixtureComparison): string[] {
  const s = f.separate.critique;
  const c = f.combined.critique;
  return [
    `| ${f.fixtureLabel} | separate | ${s.bulletCount} | ${s.flaggedCount} | ${s.byIssue.no_quantification} | ${s.byIssue.weak_verb} | ${s.byIssue.vague} | ${s.missingSectionCount} | ${s.hasSummaryFeedback ? "yes" : "no"} |`,
    `| ${f.fixtureLabel} | combined | ${c.bulletCount} | ${c.flaggedCount} | ${c.byIssue.no_quantification} | ${c.byIssue.weak_verb} | ${c.byIssue.vague} | ${c.missingSectionCount} | ${c.hasSummaryFeedback ? "yes" : "no"} |`,
  ];
}

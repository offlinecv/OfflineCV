// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Browser entry for the parse-resume eval harness (issues #241 + #262).
 *
 * Reached via `npm run eval:parse` → opens `/parse-eval.html` in the dev
 * server. Loads the selected model via WebLLM, runs BOTH:
 *   - the SEPARATE pass (`parseResumeWithLlm` + `critiqueResumeWithLlm`) — the
 *     pre-#262 baseline, kept so a reviewer can read parse-accuracy deltas.
 *   - the COMBINED pass (`analyzeResumeWithLlm`) — the new single-inference
 *     path the #262 quality-measurement gate validates.
 * over each inline fixture, scores parse halves against ground truth, and
 * computes critique structural stats. Offers downloadable JSON + Markdown
 * reports for both: the original #241 parse report (separate pass) AND the
 * new #262 side-by-side comparison report.
 *
 * This file is deliberately NOT imported by `src/main.tsx`, so it does NOT
 * contribute to the production bundle. `parse-eval.html` is a dev-only
 * sibling of `eval-rewrite.html` and `jd-spike.html`.
 *
 * Telemetry: explicitly skipped. Do NOT import or call any `track*` function
 * here — eval runs must not pollute production analytics. Mirror the spike's
 * stance: reach into the provider directly rather than going through any
 * telemetry-wired wrapper.
 *
 * ## Caller responsibility for acquire/release
 * Per web-llm.ts §"Inference callers MUST acquire BEFORE awaiting": this
 * module (as the CALLER) wraps the full load-and-eval sequence with
 * `acquireInference(modelId)` / `releaseInference(modelId)`, keyed by the
 * modelId it loads. The provider functions themselves do not call
 * acquire/release — that is the caller's contract.
 */

import { MODEL_REGISTRY, getModelById, DEFAULT_MODEL_ID } from "../models.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../web-llm.ts";
import { detectWebGpu } from "../capability.ts";
import { parseResumeWithLlm } from "../parse-resume.ts";
import { critiqueResumeWithLlm } from "../critique-resume.ts";
import { analyzeResumeWithLlm } from "../analyze-resume.ts";
import type { HeuristicParsedResume } from "../../heuristics/types.ts";

import { PARSE_EVAL_FIXTURES } from "./fixtures.ts";
import { scoreFixture, aggregateScores } from "./score.ts";
import { renderJsonReport, renderMarkdownReport } from "./report.ts";
import {
  aggregateCombinedReport,
  compareFixture,
  type CombinedFixtureComparison,
} from "./combined-score.ts";
import {
  renderCombinedJsonReport,
  renderCombinedMarkdownReport,
} from "./combined-report.ts";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

interface DomRefs {
  status: HTMLElement;
  progress: HTMLElement;
  log: HTMLElement;
  downloadJson: HTMLAnchorElement;
  downloadMd: HTMLAnchorElement;
  /** Combined-pass comparison report downloads (#262). May be null in older
   *  copies of the HTML page that haven't been updated to expose the anchors. */
  downloadComboJson: HTMLAnchorElement | null;
  downloadComboMd: HTMLAnchorElement | null;
  runBtn: HTMLButtonElement;
  modelSelect: HTMLSelectElement;
}

function getDomRefs(): DomRefs {
  return {
    status: document.getElementById("status")!,
    progress: document.getElementById("progress")!,
    log: document.getElementById("log")!,
    downloadJson: document.getElementById("download-json") as HTMLAnchorElement,
    downloadMd: document.getElementById("download-md") as HTMLAnchorElement,
    downloadComboJson: document.getElementById(
      "download-combo-json",
    ) as HTMLAnchorElement | null,
    downloadComboMd: document.getElementById(
      "download-combo-md",
    ) as HTMLAnchorElement | null,
    runBtn: document.getElementById("run") as HTMLButtonElement,
    modelSelect: document.getElementById("model") as HTMLSelectElement,
  };
}

function setStatus(refs: DomRefs, text: string): void {
  refs.status.textContent = text;
}

function appendLog(refs: DomRefs, line: string): void {
  const time = new Date().toISOString().slice(11, 19);
  refs.log.textContent = `${refs.log.textContent ?? ""}[${time}] ${line}\n`;
  refs.log.scrollTop = refs.log.scrollHeight;
}

function wireDownload(
  anchor: HTMLAnchorElement,
  filename: string,
  contents: string,
  mime: string,
): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  anchor.removeAttribute("hidden");
}

function populateModelPicker(refs: DomRefs): void {
  refs.modelSelect.innerHTML = "";
  for (const model of MODEL_REGISTRY) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} · ${model.licenseType} · ~${model.downloadSizeMb} MB`;
    if (model.id === DEFAULT_MODEL_ID) {
      option.selected = true;
    }
    refs.modelSelect.appendChild(option);
  }
}

// ---------------------------------------------------------------------------
// Run the eval for one model
// ---------------------------------------------------------------------------

async function runForModel(refs: DomRefs, modelId: string): Promise<void> {
  const meta = getModelById(modelId);
  const display = meta?.name ?? modelId;

  appendLog(refs, `loading model ${modelId}`);
  setStatus(refs, `Loading ${display} …`);

  // Acquire SYNCHRONOUSLY before any await (closes the load→use TOCTOU window
  // from #148; see web-llm.ts doc for the full rationale).
  acquireInference(modelId);
  try {
    const engine = await loadEngine(modelId, (update) => {
      refs.progress.textContent = `${display}: ${(update.progress * 100).toFixed(0)}% — ${update.text}`;
    });

    appendLog(
      refs,
      `model loaded; running ${PARSE_EVAL_FIXTURES.length} fixtures`,
    );
    setStatus(
      refs,
      `Running ${display} (${PARSE_EVAL_FIXTURES.length} fixtures) …`,
    );

    const startedAt = new Date().toISOString();
    const scores = [];
    const comparisons: CombinedFixtureComparison[] = [];

    for (let i = 0; i < PARSE_EVAL_FIXTURES.length; i++) {
      const fixture = PARSE_EVAL_FIXTURES[i]!;
      const stepBase = `${i + 1}/${PARSE_EVAL_FIXTURES.length}`;
      appendLog(refs, `running fixture: ${fixture.id}`);

      // ── SEPARATE pass: parse-only (the #241 baseline). ──
      refs.progress.textContent = `${display}: ${stepBase} ${fixture.id} — separate parse`;
      const separateParse = await parseResumeWithLlm(
        { rawText: fixture.text, markdown: fixture.markdown },
        engine,
      );

      // ── SEPARATE pass: critique on the separate parse. ──
      // The standalone critique consumes a HeuristicParsedResume; the
      // LlmParsedResume shape is structurally compatible for the fields the
      // critique reads (experience[].description, summary, skills), so we
      // adapt by spreading the LlmParsedResume into a HeuristicParsedResume
      // shape. PII is synthetic (eval fixtures), so this cast is safe.
      refs.progress.textContent = `${display}: ${stepBase} ${fixture.id} — separate critique`;
      const separateCritique = await critiqueResumeWithLlm(
        separateParse as unknown as HeuristicParsedResume,
        engine,
      );

      // ── COMBINED pass: one inference, both halves. ──
      refs.progress.textContent = `${display}: ${stepBase} ${fixture.id} — combined`;
      const combined = await analyzeResumeWithLlm(
        { rawText: fixture.text, markdown: fixture.markdown },
        engine,
      );

      // ── Score parse halves against the same ground truth. ──
      const fixtureScore = scoreFixture(
        fixture.id,
        fixture.label,
        separateParse,
        fixture.expected,
      );
      scores.push(fixtureScore);

      const comparison = compareFixture({
        fixtureId: fixture.id,
        fixtureLabel: fixture.label,
        expected: fixture.expected,
        separateParse,
        separateCritique,
        combinedParse: combined.parse,
        combinedCritique: combined.critique,
      });
      comparisons.push(comparison);

      const sP = comparison.separate.parse;
      const cP = comparison.combined.parse;
      appendLog(
        refs,
        `[${fixture.id}] sep: scalar=${(sP.scalarAccuracy * 100).toFixed(0)}% ` +
          `skills=${(sP.skillsAccuracy * 100).toFixed(0)}% ` +
          `exp=${(sP.experienceAccuracy * 100).toFixed(0)}% ` +
          `edu=${(sP.educationAccuracy * 100).toFixed(0)}%`,
      );
      appendLog(
        refs,
        `[${fixture.id}] comb: scalar=${(cP.scalarAccuracy * 100).toFixed(0)}% ` +
          `skills=${(cP.skillsAccuracy * 100).toFixed(0)}% ` +
          `exp=${(cP.experienceAccuracy * 100).toFixed(0)}% ` +
          `edu=${(cP.educationAccuracy * 100).toFixed(0)}%`,
      );
      appendLog(
        refs,
        `[${fixture.id}] critique: sep flagged=${comparison.separate.critique.flaggedCount}/${comparison.separate.critique.bulletCount}, ` +
          `comb flagged=${comparison.combined.critique.flaggedCount}/${comparison.combined.critique.bulletCount}`,
      );

      // Name the scalar field(s) that missed so a sub-100% score is actionable
      // live, not just in the downloaded report. Fixtures are synthetic, so
      // printing expected/actual here cannot leak real PII.
      for (const s of fixtureScore.scalarBreakdown) {
        if (s.status === "match" || s.status === "skipped") continue;
        appendLog(
          refs,
          `  ↳ sep ${s.field} ${s.status}: expected="${s.expected ?? ""}" actual="${s.actual ?? ""}"`,
        );
      }
    }

    // ── Reports ──
    const report = aggregateScores(modelId, startedAt, scores);
    const combinedReport = aggregateCombinedReport(
      modelId,
      startedAt,
      comparisons,
    );

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    // #241 parse-only baseline (kept for continuity).
    wireDownload(
      refs.downloadJson,
      `parse-eval-${slug}-${stamp}.json`,
      renderJsonReport(report),
      "application/json;charset=utf-8",
    );
    wireDownload(
      refs.downloadMd,
      `parse-eval-${slug}-${stamp}.md`,
      renderMarkdownReport(report),
      "text/markdown;charset=utf-8",
    );

    // #262 side-by-side comparison (the load-bearing AC artifact).
    if (refs.downloadComboJson !== null) {
      wireDownload(
        refs.downloadComboJson,
        `combined-eval-${slug}-${stamp}.json`,
        renderCombinedJsonReport(combinedReport),
        "application/json;charset=utf-8",
      );
    }
    if (refs.downloadComboMd !== null) {
      wireDownload(
        refs.downloadComboMd,
        `combined-eval-${slug}-${stamp}.md`,
        renderCombinedMarkdownReport(combinedReport),
        "text/markdown;charset=utf-8",
      );
    }

    setStatus(
      refs,
      `Done. ${PARSE_EVAL_FIXTURES.length} fixtures × 2 passes for ${display}. Download reports below.`,
    );
    appendLog(
      refs,
      "reports ready — download below and paste the combined report into PR #262 description",
    );
  } finally {
    releaseInference(modelId);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const refs = getDomRefs();
  populateModelPicker(refs);

  // Dev-only eval harness click handler — not in the production bundle and
  // not unit-tested (drives a real WebGPU run). CRAP is high only because
  // coverage is 0; the branching is a flat try/guard/finally.
  // fallow-ignore-next-line complexity
  refs.runBtn.addEventListener("click", async () => {
    refs.runBtn.disabled = true;
    refs.modelSelect.disabled = true;
    refs.downloadJson.setAttribute("hidden", "");
    refs.downloadMd.setAttribute("hidden", "");
    refs.log.textContent = "";

    try {
      const capability = await detectWebGpu();
      if (capability !== "available") {
        setStatus(refs, `WebGPU not available: ${capability}`);
        appendLog(refs, `WebGPU check: ${capability}`);
        return;
      }

      const modelId = refs.modelSelect.value;
      const meta = getModelById(modelId);
      if (!meta) {
        setStatus(refs, `Unknown model: ${modelId}`);
        return;
      }

      appendLog(refs, `WebGPU available; running ${meta.name}`);
      await runForModel(refs, modelId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(refs, `Failed: ${message}`);
      appendLog(refs, `ERROR: ${message}`);
    } finally {
      refs.runBtn.disabled = false;
      refs.modelSelect.disabled = false;
    }
  });
}

void main();

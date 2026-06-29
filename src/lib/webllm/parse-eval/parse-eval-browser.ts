// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors
// fallow-ignore-file unused-file

/**
 * Browser entry for the parse-resume eval harness (issue #241).
 *
 * Reached via `npm run eval:parse` → opens `/parse-eval.html` in the dev
 * server. Loads the selected model via WebLLM, runs `parseResumeWithLlm`
 * over each inline fixture, scores with the deterministic scorer, and offers
 * downloadable JSON + Markdown reports.
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
 * modelId it loads. The `parseResumeWithLlm` function itself does not call
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

import { PARSE_EVAL_FIXTURES } from "./fixtures.ts";
import { scoreFixture, aggregateScores } from "./score.ts";
import { renderJsonReport, renderMarkdownReport } from "./report.ts";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

interface DomRefs {
  status: HTMLElement;
  progress: HTMLElement;
  log: HTMLElement;
  downloadJson: HTMLAnchorElement;
  downloadMd: HTMLAnchorElement;
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

    for (let i = 0; i < PARSE_EVAL_FIXTURES.length; i++) {
      const fixture = PARSE_EVAL_FIXTURES[i]!;
      refs.progress.textContent = `${display}: ${i + 1}/${PARSE_EVAL_FIXTURES.length} — ${fixture.id}`;
      appendLog(refs, `running fixture: ${fixture.id}`);

      const actual = await parseResumeWithLlm(
        { rawText: fixture.text, markdown: fixture.markdown },
        engine,
      );

      const fixtureScore = scoreFixture(
        fixture.id,
        fixture.label,
        actual,
        fixture.expected,
      );
      scores.push(fixtureScore);

      appendLog(
        refs,
        `[${fixture.id}] validJson=${fixtureScore.validJson} ` +
          `scalar=${(fixtureScore.scalarAccuracy * 100).toFixed(0)}% ` +
          `skills=${(fixtureScore.skillsAccuracy * 100).toFixed(0)}% ` +
          `exp=${(fixtureScore.experienceAccuracy * 100).toFixed(0)}% ` +
          `edu=${(fixtureScore.educationAccuracy * 100).toFixed(0)}%`,
      );
    }

    const report = aggregateScores(modelId, startedAt, scores);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-");

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

    setStatus(
      refs,
      `Done. ${PARSE_EVAL_FIXTURES.length} fixtures for ${display}. Download report below.`,
    );
    appendLog(
      refs,
      "report ready — download below and paste into PR #241 description",
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

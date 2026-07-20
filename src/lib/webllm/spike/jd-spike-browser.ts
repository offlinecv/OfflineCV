// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Browser entry for the JD-extraction + evidence-judging spike (issue #198).
 *
 * Reached via `npm run eval:jd-spike` or by opening
 * `http://localhost:5173/offlinecv/jd-spike.html` while the dev server
 * is running. Loads the selected model via WebLLM, runs the spike
 * measurement over the 3 inline fixtures (see fixtures.ts), and offers
 * downloadable JSON + Markdown reports.
 *
 * This file is deliberately NOT imported by `src/main.tsx`, so it does
 * NOT contribute to the production bundle. `jd-spike.html` is a dev-only
 * sibling of `eval-rewrite.html` — Vite serves it but never builds it
 * into `dist/`.
 *
 * Telemetry: explicitly skipped. Do not import or call any `track*`
 * function here — spike runs must not pollute production analytics.
 */

import { MODEL_REGISTRY, getModelById, DEFAULT_MODEL_ID } from "../models.ts";
import { loadEngine } from "../web-llm.ts";
import { detectWebGpu } from "../capability.ts";
import { SPIKE_FIXTURES } from "./fixtures.ts";
import { measureAll, renderJsonReport, renderMarkdownReport } from "./measure.ts";

// ---------------------------------------------------------------------------
// Default repeats — user can change via the input on the page
// ---------------------------------------------------------------------------
const DEFAULT_REPEATS = 3;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

interface DomRefs {
  status: HTMLElement;
  progress: HTMLElement;
  log: HTMLElement;
  downloadJson: HTMLAnchorElement;
  downloadMd: HTMLAnchorElement;
  runBtn: HTMLButtonElement;
  modelSelect: HTMLSelectElement;
  repeatsInput: HTMLInputElement;
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
    repeatsInput: document.getElementById("repeats") as HTMLInputElement,
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
// Run
// ---------------------------------------------------------------------------

async function runSpike(refs: DomRefs, modelId: string, repeats: number): Promise<void> {
  const meta = getModelById(modelId);
  const display = meta?.name ?? modelId;

  appendLog(refs, `loading model ${modelId}`);
  setStatus(refs, `Loading ${display} …`);

  const engine = await loadEngine(modelId, (update) => {
    refs.progress.textContent = `${display}: ${(update.progress * 100).toFixed(0)}% — ${update.text}`;
  });

  appendLog(refs, `model loaded; running ${SPIKE_FIXTURES.length} fixtures × ${repeats} repeats`);
  setStatus(refs, `Running ${display} (${SPIKE_FIXTURES.length} fixtures × ${repeats} repeats) …`);

  const report = await measureAll(engine, modelId, SPIKE_FIXTURES, {
    repeats,
    onProgress: (done, total, label) => {
      refs.progress.textContent = `${display}: ${done}/${total} — ${label}`;
    },
    onLog: (msg) => appendLog(refs, msg),
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  wireDownload(
    refs.downloadJson,
    `jd-spike-${slug}-${stamp}.json`,
    renderJsonReport(report),
    "application/json;charset=utf-8",
  );
  wireDownload(
    refs.downloadMd,
    `jd-spike-${slug}-${stamp}.md`,
    renderMarkdownReport(report),
    "text/markdown;charset=utf-8",
  );

  setStatus(refs, `Done. ${SPIKE_FIXTURES.length} fixtures × ${repeats} repeats for ${display}.`);
  appendLog(refs, "report ready — download below and paste findings into issue #156");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const refs = getDomRefs();
  populateModelPicker(refs);
  refs.repeatsInput.value = String(DEFAULT_REPEATS);

  refs.runBtn.addEventListener("click", async () => {
    refs.runBtn.disabled = true;
    refs.modelSelect.disabled = true;
    refs.repeatsInput.disabled = true;
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

      const repeats = Math.max(1, parseInt(refs.repeatsInput.value, 10) || DEFAULT_REPEATS);
      appendLog(refs, `WebGPU available; running ${meta.name} × ${repeats} repeats`);
      await runSpike(refs, modelId, repeats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(refs, `Failed: ${message}`);
      appendLog(refs, `ERROR: ${message}`);
    } finally {
      refs.runBtn.disabled = false;
      refs.modelSelect.disabled = false;
      refs.repeatsInput.disabled = false;
    }
  });
}

void main();

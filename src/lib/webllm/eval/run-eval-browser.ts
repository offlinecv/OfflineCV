// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Browser entry for the rewrite-quality eval harness.
 *
 * Reached via `npm run eval:rewrite` → opens
 * `/offlinecv/eval-rewrite.html` in the dev server. Loads the model
 * the user picked, runs every prompt variant against every fixture,
 * scores with the deterministic rubric, and renders a downloadable
 * JSON + Markdown report.
 *
 * One model per tab on purpose. Cycling all three registry models in a
 * single tab kept crashing Chrome on consumer GPUs during the
 * eviction-then-reload path — eviction calls `.unload()` but VRAM
 * isn't guaranteed to be free by the time the next model starts
 * downloading. A fresh tab per model sidesteps that entirely: the
 * prior tab's GPU resources are reclaimed on close. The downside is
 * the maintainer commits one report file per model and a reviewer
 * compares them side-by-side — still cheap.
 *
 * This file is deliberately NOT imported by `src/main.tsx`, so it does
 * not contribute to the production bundle. The Vite root has
 * `index.html` as the sole prod input — `eval-rewrite.html` is a
 * dev-only sibling page that Vite serves but does not build.
 *
 * Telemetry: the eval explicitly skips analytics. The shipped rewrite
 * APIs fire telemetry, so the eval reaches into the engine directly
 * instead of calling `rewriteSectionWithLlm`. That keeps an eval run
 * from polluting `webllm_section_rewrite_*` counters during local
 * benchmarking.
 */

import { cleanRewriteLine } from "../post-process.ts";
import {
  buildSectionUserPrompt,
  sectionMaxTokens,
} from "../rewrite-section.ts";
import { MODEL_REGISTRY, getModelById } from "../models.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../web-llm.ts";
import { detectWebGpu } from "../capability.ts";
import type { WebLlmEngine } from "../types.ts";

import { REWRITE_FIXTURES } from "./fixtures.ts";
import { PROMPT_VARIANTS } from "./prompt-variants.ts";
import { renderJsonReport, renderMarkdownReport } from "./report.ts";
import { runEval } from "./runner.ts";
import type { RawRewriteOutput, RewriteFn } from "./types.ts";

declare const __APP_VERSION__: string;

const SECTION_TEMPERATURE = 0.3;

/**
 * Build a `RewriteFn` backed by a real WebLLM engine + custom prompt.
 * The system prompt is the variant's; the user prompt is the shared
 * `buildSectionUserPrompt` shape from production so output framing
 * stays comparable to the shipped path.
 */
function makeRealRewriteFn(engine: WebLlmEngine): RewriteFn {
  return async ({ variantId, fixture }) => {
    const variant = PROMPT_VARIANTS.find((v) => v.id === variantId);
    if (!variant) throw new Error(`unknown variant: ${variantId}`);

    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: variant.systemPrompt },
        { role: "user", content: buildSectionUserPrompt(fixture.bullets) },
      ],
      temperature: SECTION_TEMPERATURE,
      max_tokens: sectionMaxTokens(fixture.bullets.length),
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const bullets = raw
      .split("\n")
      .map((line) => cleanRewriteLine(line))
      .filter((line) => line.length > 0);
    return { bullets, raw } satisfies RawRewriteOutput;
  };
}

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
    refs.modelSelect.appendChild(option);
  }
}

async function runForModel(refs: DomRefs, modelId: string): Promise<void> {
  const meta = getModelById(modelId);
  const display = meta?.name ?? modelId;

  appendLog(refs, `loading model ${modelId}`);
  setStatus(refs, `Loading ${display} …`);
  // Acquire the inference guard SYNCHRONOUSLY, before any await — closes
  // the load→use TOCTOU window from #148. This path is the most exposed of
  // all call sites: `makeRealRewriteFn` calls `engine.chat.completions.create`
  // directly, bypassing the rewrite primitives' internal acquire/release
  // belt, so the engine has NO inflight tracking during the eval loop
  // without this wrapper. Held across the whole eval (load + N × variant
  // × fixture rewrites + report wiring) so a re-click of the run button
  // with a different model can't tear down our engine mid-eval.
  acquireInference(modelId);
  try {
    const engine = await loadEngine(modelId, (update) => {
      refs.progress.textContent = `${display}: ${(update.progress * 100).toFixed(0)}% — ${update.text}`;
    });
    appendLog(
      refs,
      `model loaded; running ${PROMPT_VARIANTS.length} variants × ${REWRITE_FIXTURES.length} fixtures`,
    );
    // Refresh the status line so it reflects "running" instead of staying
    // on "Loading …" for the whole cell loop.
    setStatus(refs, `Running ${display} (${PROMPT_VARIANTS.length} variants × ${REWRITE_FIXTURES.length} fixtures) …`);

    const report = await runEval({
      modelIds: [modelId],
      variantIds: PROMPT_VARIANTS.map((v) => v.id),
      fixtures: REWRITE_FIXTURES,
      rewriteFn: makeRealRewriteFn(engine),
      appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null,
      onProgress: (done, total, cell) => {
        refs.progress.textContent = `${display}: ${done}/${total} — ${cell.variantId} × ${cell.fixtureId}`;
      },
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // Slugify the model id for the filename so it's filesystem-safe and
    // easy to read in the reports/ directory.
    const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // Explicit `;charset=utf-8` so the saved files don't get re-decoded as
    // Latin-1 by some text viewers — without it, multi-byte chars like
    // `×` and `—` in the markdown render as mojibake.
    wireDownload(
      refs.downloadJson,
      `eval-rewrite-${slug}-${stamp}.json`,
      renderJsonReport(report),
      "application/json;charset=utf-8",
    );
    wireDownload(
      refs.downloadMd,
      `eval-rewrite-${slug}-${stamp}.md`,
      renderMarkdownReport(report),
      "text/markdown;charset=utf-8",
    );
    setStatus(
      refs,
      `Done. ${report.records.length} records scored for ${display}.`,
    );
    appendLog(
      refs,
      "report ready — download below and commit under tests/fixtures/rewrite/reports/",
    );
  } finally {
    releaseInference(modelId);
  }
}

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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Run logic for the JD spike (issue #198).
 *
 * For each fixture × repeat:
 *   1. Call 1 (extract): JD text → JdRequirement[] — measure tokens + latency + parse mode
 *   2. Call 2 (judge):   batch the extracted requirements → RequirementVerdict[] per batch
 *
 * All `engine.chat.completions.create()` calls are bracketed with
 * acquireInference / releaseInference per the web-llm.ts contract.
 *
 * This module is pure-ish over the engine handle — no module-level state,
 * so it's safe to call from the browser entry without side effects.
 */

import { acquireInference, releaseInference } from "../web-llm.ts";
import type { WebLlmEngine } from "../types.ts";
import type {
  CallMeasurement,
  FixtureStats,
  JdRequirement,
  RunMeasurements,
  SpikeReport,
} from "./types.ts";
import type { SpikeFixture } from "./fixtures.ts";
import {
  JUDGE_BATCH_SIZE,
  EXTRACT_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
  buildExtractUserPrompt,
  buildJudgeUserPrompt,
} from "./prompts.ts";

// ---------------------------------------------------------------------------
// JSON parse helpers
// ---------------------------------------------------------------------------

/**
 * Try to parse a model response as JSON. If strict parse fails, attempt
 * tolerant repairs:
 *   1. Strip ```json ... ``` (and bare ``` ... ```) fences
 *   2. Extract the first `[...]` bracket span
 *
 * Returns the parsed value and the parse mode used.
 */
function tryParseJson(raw: string): { value: unknown; parseMode: CallMeasurement["parseMode"] } {
  // Strict
  try {
    return { value: JSON.parse(raw), parseMode: "strict" };
  } catch {
    // Continue to repairs
  }

  // Repair 1: strip markdown fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return { value: JSON.parse(stripped), parseMode: "repaired" };
  } catch {
    // Continue to repair 2
  }

  // Repair 2: extract first [...] span
  const bracketMatch = /\[[\s\S]*\]/.exec(stripped);
  if (bracketMatch) {
    try {
      return { value: JSON.parse(bracketMatch[0]), parseMode: "repaired" };
    } catch {
      // Fall through
    }
  }

  return { value: null, parseMode: "failed" };
}

// ---------------------------------------------------------------------------
// Type for usage — WebLLM's OpenAI-compatible response includes this field
// but the narrow types.ts stub doesn't expose it, so we read it via a cast.
// ---------------------------------------------------------------------------

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function extractUsage(response: unknown): UsageLike {
  if (response && typeof response === "object" && "usage" in response) {
    const u = (response as { usage: unknown }).usage;
    if (u && typeof u === "object") {
      return u as UsageLike;
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Single call with measurement
// ---------------------------------------------------------------------------

async function measuredCall(
  engine: WebLlmEngine,
  modelId: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens: number,
): Promise<{ raw: string; measurement: CallMeasurement }> {
  const start = Date.now();
  acquireInference(modelId);
  let raw = "";
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const response = await engine.chat.completions.create({
      messages,
      temperature: 0,
      max_tokens: maxTokens,
    });
    raw = response.choices[0]?.message?.content ?? "";
    const usage = extractUsage(response);
    promptTokens = usage.prompt_tokens ?? 0;
    completionTokens = usage.completion_tokens ?? 0;
  } finally {
    releaseInference(modelId);
  }
  const latencyMs = Date.now() - start;
  const { parseMode } = tryParseJson(raw);
  return {
    raw,
    measurement: { promptTokens, completionTokens, latencyMs, parseMode },
  };
}

// ---------------------------------------------------------------------------
// One fixture × one repeat
// ---------------------------------------------------------------------------

async function runOnce(
  engine: WebLlmEngine,
  modelId: string,
  fixture: SpikeFixture,
  onLog: (msg: string) => void,
): Promise<RunMeasurements> {
  // Call 1: extract requirements from JD
  const extractMessages = [
    { role: "system" as const, content: EXTRACT_SYSTEM_PROMPT },
    { role: "user" as const, content: buildExtractUserPrompt(fixture.jdText) },
  ];
  // Allow up to 1024 tokens for the extracted requirement array
  const { raw: extractRaw, measurement: extractCall } = await measuredCall(
    engine,
    modelId,
    extractMessages,
    1024,
  );

  // Parse extract result — best-effort; on failure we use an empty array so judge runs
  let requirements: JdRequirement[] = [];
  const { value: extractedValue } = tryParseJson(extractRaw);
  if (Array.isArray(extractedValue)) {
    requirements = extractedValue as JdRequirement[];
  }
  onLog(
    `[${fixture.id}] extract: ${requirements.length} requirements, ` +
    `${extractCall.promptTokens}pt/${extractCall.completionTokens}ct, ` +
    `${extractCall.latencyMs}ms, parse=${extractCall.parseMode}`,
  );

  // Call 2: judge requirements in batches
  const judgeCalls: CallMeasurement[] = [];
  for (let i = 0; i < Math.max(1, requirements.length); i += JUDGE_BATCH_SIZE) {
    const batch = requirements.slice(i, i + JUDGE_BATCH_SIZE);
    if (batch.length === 0) break;

    const judgeMessages = [
      { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: buildJudgeUserPrompt(batch, fixture.resumeProjection),
      },
    ];
    // Allow up to 1024 tokens for the verdict array
    const { measurement: judgeCall } = await measuredCall(
      engine,
      modelId,
      judgeMessages,
      1024,
    );
    judgeCalls.push(judgeCall);
    onLog(
      `[${fixture.id}] judge batch ${Math.floor(i / JUDGE_BATCH_SIZE) + 1}: ` +
      `${judgeCall.promptTokens}pt/${judgeCall.completionTokens}ct, ` +
      `${judgeCall.latencyMs}ms, parse=${judgeCall.parseMode}`,
    );
  }

  return { extractCall, judgeCalls };
}

// ---------------------------------------------------------------------------
// Per-fixture aggregation
// ---------------------------------------------------------------------------

function aggregateFixture(
  fixtureId: string,
  allRuns: RunMeasurements[],
): FixtureStats {
  const repeats = allRuns.length;

  const extractFailures = allRuns.filter((r) => r.extractCall.parseMode === "failed").length;
  const extractFailureRate = repeats > 0 ? extractFailures / repeats : 0;

  const allJudgeCalls = allRuns.flatMap((r) => r.judgeCalls);
  const judgeFailures = allJudgeCalls.filter((c) => c.parseMode === "failed").length;
  const judgeFailureRate = allJudgeCalls.length > 0 ? judgeFailures / allJudgeCalls.length : 0;

  const extractMaxPromptTokens = Math.max(0, ...allRuns.map((r) => r.extractCall.promptTokens));
  const judgeMaxPromptTokens = Math.max(0, ...allJudgeCalls.map((c) => c.promptTokens));

  const extractColdLatencyMs = allRuns[0]?.extractCall.latencyMs ?? 0;
  const warmRuns = allRuns.slice(1);
  const extractWarmLatencyMs =
    warmRuns.length > 0
      ? warmRuns.reduce((s, r) => s + r.extractCall.latencyMs, 0) / warmRuns.length
      : null;

  const judgeWarmLatencyMs =
    allJudgeCalls.length > 0
      ? allJudgeCalls.reduce((s, c) => s + c.latencyMs, 0) / allJudgeCalls.length
      : null;

  return {
    fixtureId,
    repeats,
    extractFailureRate,
    judgeFailureRate,
    extractMaxPromptTokens,
    judgeMaxPromptTokens,
    extractColdLatencyMs,
    extractWarmLatencyMs,
    judgeWarmLatencyMs,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface MeasureOptions {
  /** Repeats per fixture (default: 3). */
  repeats?: number;
  /** Progress callback for the browser UI. */
  onProgress?: (done: number, total: number, label: string) => void;
  /** Log callback for verbose output. */
  onLog?: (msg: string) => void;
}

/**
 * Run the spike measurement over all fixtures.
 *
 * @param engine — A loaded WebLLM engine (from `loadEngine`).
 * @param modelId — The model id used to load the engine (for acquire/release).
 * @param fixtures — The spike fixtures to run.
 * @param opts — Optional config (repeats, callbacks).
 */
export async function measureAll(
  engine: WebLlmEngine,
  modelId: string,
  fixtures: readonly SpikeFixture[],
  opts: MeasureOptions = {},
): Promise<SpikeReport> {
  const { repeats = 3, onProgress, onLog = () => {} } = opts;
  const startedAt = new Date().toISOString();

  const total = fixtures.length * repeats;
  let done = 0;

  const fixtureStatsList: FixtureStats[] = [];

  for (const fixture of fixtures) {
    const allRuns: RunMeasurements[] = [];
    for (let r = 0; r < repeats; r++) {
      onLog(`--- ${fixture.id} repeat ${r + 1}/${repeats} ---`);
      const run = await runOnce(engine, modelId, fixture, onLog);
      allRuns.push(run);
      done += 1;
      onProgress?.(done, total, `${fixture.id} repeat ${r + 1}`);
    }
    fixtureStatsList.push(aggregateFixture(fixture.id, allRuns));
  }

  // Overall aggregates
  const overallExtractFailureRate =
    fixtureStatsList.reduce((s, f) => s + f.extractFailureRate * f.repeats, 0) /
    Math.max(1, fixtureStatsList.reduce((s, f) => s + f.repeats, 0));

  // For judge failure rate, weight by actual judge call counts
  const totalJudgeCalls = fixtureStatsList.reduce(
    (s, f) => s + (f.judgeWarmLatencyMs !== null ? f.repeats : 0), 0
  );
  const overallJudgeFailureRate =
    totalJudgeCalls > 0
      ? fixtureStatsList.reduce((s, f) => s + f.judgeFailureRate * f.repeats, 0) /
        Math.max(1, totalJudgeCalls)
      : 0;

  const overallMaxExtractPromptTokens = Math.max(
    0,
    ...fixtureStatsList.map((f) => f.extractMaxPromptTokens),
  );
  const overallMaxJudgePromptTokens = Math.max(
    0,
    ...fixtureStatsList.map((f) => f.judgeMaxPromptTokens),
  );

  return {
    startedAt,
    modelId,
    repeatsPerFixture: repeats,
    fixtures: fixtureStatsList,
    overallExtractFailureRate,
    overallJudgeFailureRate,
    overallMaxExtractPromptTokens,
    overallMaxJudgePromptTokens,
  };
}

// ---------------------------------------------------------------------------
// Report renderers
// ---------------------------------------------------------------------------

/** Render the spike report as compact pretty-printed JSON. */
export function renderJsonReport(report: SpikeReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function msOrDash(v: number | null): string {
  return v === null ? "—" : `${Math.round(v)} ms`;
}

/** Render the spike report as Markdown (for pasting into issue #156). */
export function renderMarkdownReport(report: SpikeReport): string {
  const lines: string[] = [];
  lines.push("# JD Spike Report (issue #198 / #156)");
  lines.push("");
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push(`- **Model:** \`${report.modelId}\``);
  lines.push(`- **Repeats per fixture:** ${report.repeatsPerFixture}`);
  lines.push(`- **Qwen2.5-1.5B context window:** 32 768 tokens`);
  lines.push("");

  lines.push("## Overall");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Extract JSON failure rate | ${pct(report.overallExtractFailureRate)} |`);
  lines.push(`| Judge JSON failure rate | ${pct(report.overallJudgeFailureRate)} |`);
  lines.push(`| Max extract prompt tokens | ${report.overallMaxExtractPromptTokens} |`);
  lines.push(`| Max judge prompt tokens | ${report.overallMaxJudgePromptTokens} |`);
  lines.push("");

  lines.push("## Per-fixture breakdown");
  lines.push("");
  lines.push(
    "| Fixture | Extract fail% | Judge fail% | Extract max pt | Judge max pt | Extract cold | Extract warm | Judge mean |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const f of report.fixtures) {
    lines.push(
      `| ${f.fixtureId} | ${pct(f.extractFailureRate)} | ${pct(f.judgeFailureRate)} | ` +
      `${f.extractMaxPromptTokens} | ${f.judgeMaxPromptTokens} | ` +
      `${msOrDash(f.extractColdLatencyMs)} | ${msOrDash(f.extractWarmLatencyMs)} | ${msOrDash(f.judgeWarmLatencyMs)} |`,
    );
  }
  lines.push("");
  lines.push(
    "> **Token headroom:** Qwen2.5-1.5B context is 32 768 tokens. " +
    "Prompt tokens well below 2 000 indicates ample budget for production use.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_Generated by the JD spike harness. Paste findings into issue #156._");
  lines.push("");

  return lines.join("\n");
}

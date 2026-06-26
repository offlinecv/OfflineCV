// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { cleanRewriteLine } from "./post-process.ts";
import { checkNumbersPreserved } from "./preserve-numbers.ts";
import { buildSteeringSuffix, type RewriteSteering } from "./steering.ts";
import type { WebLlmEngine } from "./types.ts";
import { acquireInference, releaseInference } from "./web-llm.ts";

/**
 * Summary-paragraph rewrite primitive used by the chain-of-sections
 * orchestrator (#67).
 *
 * The summary section is the first section in the chain. It is a 2–3
 * sentence paragraph rather than a bullet list, so the bullet-shaped
 * `rewriteSectionWithLlm` prompt does not fit — it would coerce the model
 * into emitting one bullet per line and we'd lose the paragraph shape.
 *
 * Mirrors the section primitive's contracts:
 *   - Takes the engine + model id so telemetry can be model-dimensioned and
 *     the cross-model `acquireInference` lock can defer `.unload()` while
 *     this call is in flight.
 *   - Runs the deterministic number-preservation check after the model
 *     responds (same `checkNumbersPreserved` used by the section path —
 *     the multiset diff is shape-agnostic).
 *   - Returns `numbersPreserved` + `dropped/added` so the UI can surface
 *     the same inline warning shape as the section path.
 *
 * Output handling: paragraphs sometimes come back across multiple lines if
 * the model adds a wrap (or hallucinates a `Rewritten:` echo). We run each
 * non-empty line through the shared `cleanRewriteLine` helper, then join
 * with a single space — that flattens any spurious wrap without losing
 * intra-paragraph punctuation.
 *
 * No first-rewrite telemetry: the orchestrator owns the resume-level
 * one-shot flag (`webllm_first_resume_rewrite`). The per-section /
 * per-bullet one-shots stay distinct so the funnels don't cross-pollute.
 */
export const SUMMARY_REWRITE_SYSTEM_PROMPT = `You are rewriting a resume summary to be more specific and outcome-oriented.
Rules:
- Output a single paragraph of 2–3 sentences. No bullet points. No numbering. No quotes. No preamble.
- Lead with the strongest concrete claim (years of experience, primary domain, or signature outcome).
- Preserve every concrete number from the input EXACTLY. Do not invent new numbers or metrics.
- Drop generic filler ("hard-working", "team player", "passionate"). Keep specifics.
- If the summary is already strong, keep it unchanged.`;

const SUMMARY_MAX_TOKENS = 256;

export function buildSummaryUserPrompt(summary: string): string {
  return `Original summary:\n${summary.trim()}\n\nRewritten summary:`;
}

/**
 * System-prompt builder. Mirrors `buildSectionSystemPrompt` — the
 * chain-of-sections orchestrator (#67) folds rolling context into the
 * SYSTEM message, not the user message, so small instruct models don't
 * read the prior-section preview as content to echo.
 */
export function buildSummarySystemPrompt(
  context?: string,
  steering?: RewriteSteering,
): string {
  const base =
    !context || context.trim().length === 0
      ? SUMMARY_REWRITE_SYSTEM_PROMPT
      : `${SUMMARY_REWRITE_SYSTEM_PROMPT}

Other sections of this résumé will be rewritten next. The user's NEXT message contains the summary paragraph — only rewrite THAT. Do not include content from later sections in your output.

Context for tone consistency (reference only — never echo into your output):
${context.trim()}`;
  return `${base}${buildSteeringSuffix(steering)}`;
}

export interface SummaryRewriteOptions {
  /** Rolling soft-constraint brief from the chain-of-sections orchestrator. */
  context?: string;
  /**
   * User-supplied rewrite steering (#210): freeform instructions + an optional
   * page-length target, appended to the SYSTEM message after the guardrails.
   * Undefined → no behaviour change.
   */
  steering?: RewriteSteering;
}

export interface SummaryRewriteResult {
  /** The rewritten summary paragraph. Empty string when the model returned nothing. */
  text: string;
  /** True iff every input number survived and none were invented. */
  numbersPreserved: boolean;
  /** Numeric tokens that did not survive (UI surfaces these inline). */
  droppedNumbers: string[];
  /** Numeric tokens that appeared from nowhere (UI surfaces these inline). */
  addedNumbers: string[];
}

/**
 * Rewrite a summary paragraph using a loaded WebLLM engine.
 *
 * Pure over `engine` — the engine is passed in so tests can supply a stub
 * implementing the `WebLlmEngine` contract without touching the real model.
 *
 * `modelId` is required for the cross-model inference guard
 * (`acquireInference` / `releaseInference`). The orchestrator owns this
 * call's lifecycle and fires the resume-level telemetry; this primitive is
 * deliberately quiet so existing per-section telemetry funnels don't pick
 * up summary-rewrite events.
 */
export async function rewriteSummaryWithLlm(
  summary: string,
  engine: WebLlmEngine,
  modelId: string,
  options: SummaryRewriteOptions = {},
): Promise<SummaryRewriteResult> {
  acquireInference(modelId);
  try {
    const response = await engine.chat.completions.create({
      messages: [
        {
          role: "system",
          content: buildSummarySystemPrompt(options.context, options.steering),
        },
        { role: "user", content: buildSummaryUserPrompt(summary) },
      ],
      temperature: 0.3,
      max_tokens: SUMMARY_MAX_TOKENS,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const text = raw
      .split("\n")
      .map((line) => cleanRewriteLine(line))
      .filter((line) => line.length > 0)
      .join(" ")
      .trim();

    const preservation = checkNumbersPreserved([summary], text ? [text] : []);

    return {
      text,
      numbersPreserved: preservation.ok,
      droppedNumbers: preservation.dropped,
      addedNumbers: preservation.added,
    };
  } finally {
    releaseInference(modelId);
  }
}

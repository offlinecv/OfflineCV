// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import {
  applyNumberPreservation,
  cleanRewriteLine,
} from "./post-process.ts";
import {
  composeRulesPrompt,
  DROP_FILLER_RULE,
  keepIfAlreadyStrongRule,
  PRESERVE_NUMBERS_RULE,
  rewriteTaskLine,
  SUMMARY_LEAD_RULE,
} from "./rewrite-guardrails.ts";
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
 *     responds (same `applyNumberPreservation` used by the section path —
 *     the set diff is shape-agnostic), including the #778 reject gate:
 *     a rewrite that drops or invents a number returns the ORIGINAL paragraph.
 *   - Returns `numbersPreserved` + `reverted` + `dropped/added` so the UI can
 *     surface the same inline warning shape as the section path.
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
/**
 * The single-paragraph output contract. Local for the same reason
 * `SECTION_OUTPUT_CONTRACT` is (#609): the shape of the output is what the two
 * on-device prompts do NOT share with each other or with the exported prompt.
 */
const SUMMARY_OUTPUT_CONTRACT =
  "Output a single paragraph of 2–3 sentences. No bullet points. No numbering. No quotes. No preamble.";

export const SUMMARY_REWRITE_SYSTEM_PROMPT = composeRulesPrompt(
  rewriteTaskLine("a resume summary"),
  [
    SUMMARY_OUTPUT_CONTRACT,
    SUMMARY_LEAD_RULE,
    PRESERVE_NUMBERS_RULE,
    DROP_FILLER_RULE,
    keepIfAlreadyStrongRule("the summary"),
  ],
);

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
  summary?: string,
): string {
  const base =
    !context || context.trim().length === 0
      ? SUMMARY_REWRITE_SYSTEM_PROMPT
      : `${SUMMARY_REWRITE_SYSTEM_PROMPT}

Other sections of this résumé will be rewritten next. The user's NEXT message contains the summary paragraph — only rewrite THAT. Do not include content from later sections in your output.

Context for tone consistency (reference only — never echo into your output):
${context.trim()}`;
  // The summary is a single unit, so it scopes `steering.findings` as a
  // one-element list (#608) and renders unnumbered ("- Summary: …"). The
  // critique's `summaryFeedback` is filed under this very text by
  // `findingsFromCritique`. Omitted → findings contribute nothing.
  return `${base}${buildSteeringSuffix(
    steering,
    summary === undefined ? undefined : [summary],
    "Summary",
  )}`;
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
  /**
   * What the user gets. Empty string when the model returned nothing; the
   * ORIGINAL paragraph when the #778 gate rejected the rewrite.
   */
  text: string;
  /** True iff `text` carries every input number and invents none. */
  numbersPreserved: boolean;
  /**
   * The rewrite dropped or invented a number and was rejected; `text` is the
   * original paragraph (#778). The panel must say so rather than showing an
   * empty diff.
   */
  reverted: boolean;
  /** Numeric tokens the model dropped (UI surfaces these inline). */
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
          content: buildSummarySystemPrompt(
            options.context,
            options.steering,
            summary,
          ),
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

    // #778, applied to the one-unit paragraph shape: `applyNumberPreservation`
    // works on arrays, so wrap and unwrap. A blank generation stays blank —
    // the gate deliberately leaves an empty rewrite to the caller's
    // failed-generation handling rather than dressing it up as "kept yours".
    const outcome = applyNumberPreservation(
      [summary],
      text ? [text] : [],
    );

    return {
      text: outcome.bullets[0] ?? "",
      numbersPreserved: outcome.numbersPreserved,
      reverted: outcome.reverted,
      droppedNumbers: outcome.droppedNumbers,
      addedNumbers: outcome.addedNumbers,
    };
  } finally {
    releaseInference(modelId);
  }
}

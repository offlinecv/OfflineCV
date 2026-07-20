// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import {
  trackWebllmFirstSectionRewrite,
  trackWebllmSectionRewriteCompleted,
  trackWebllmSectionRewriteStarted,
} from "../analytics.ts";
import { cleanRewriteLine } from "./post-process.ts";
import { checkNumbersPreserved } from "./preserve-numbers.ts";
import { buildSteeringSuffix, type RewriteSteering } from "./steering.ts";
import type { WebLlmEngine } from "./types.ts";
import { acquireInference, releaseInference } from "./web-llm.ts";

/**
 * System prompt for whole-section rewrite.
 *
 * Per issue #63: replace-whole-block lets the model dedupe, merge, drop weak
 * bullets, reorder, and balance verb variety — none of that is reachable
 * from the per-bullet path. The number-preservation guardrail runs
 * deterministically on the output (see preserve-numbers.ts), so the prompt
 * leans on the model to *try* to preserve numbers but doesn't depend on it.
 *
 * Tuned for Qwen2.5-1.5B-Instruct: small models need the rules stated
 * emphatically. "One bullet per line, no preamble, no numbering, no quotes"
 * has to be repeated because each rule is broken often enough on its own.
 */
export const SECTION_REWRITE_SYSTEM_PROMPT = `You are rewriting a list of resume bullets to be more specific and outcome-oriented.
Rules:
- Output one bullet per line. No numbering. No bullet markers. No quotes. No preamble.
- Lead every bullet with a strong action verb.
- Preserve every concrete number from the input EXACTLY. Do not invent new numbers or metrics.
- You may merge two weak bullets into one strong bullet, drop pure filler, or reorder for emphasis.
- Vary the action verbs across bullets — don't start every line the same way.
- If a bullet is already strong, keep it unchanged.`;

const SECTION_MAX_TOKENS_PER_BULLET = 60;
const SECTION_MAX_TOKENS_CEILING = 768;

/**
 * Per issue #63 decision #2: `min(60 * bullets.length, 768)`.
 *
 * `max(bulletCount, 1)` keeps the floor at 60 even if called with 0 bullets.
 * The literal spec value at N=0 would be 0, which is an invalid max_tokens.
 * SectionRewrite already filters empty arrays out before calling, so this
 * floor is purely defensive for the standalone API surface.
 */
export function sectionMaxTokens(bulletCount: number): number {
  return Math.min(
    SECTION_MAX_TOKENS_PER_BULLET * Math.max(bulletCount, 1),
    SECTION_MAX_TOKENS_CEILING,
  );
}

export function buildSectionUserPrompt(bullets: readonly string[]): string {
  const numbered = bullets
    .map((b, i) => `${i + 1}. ${b.trim()}`)
    .join("\n");
  return `Original bullets:\n${numbered}\n\nRewritten bullets:`;
}

/**
 * System-prompt builder. The base rules are constant; the chain-of-sections
 * orchestrator (#67) optionally appends a "context from earlier sections"
 * block that the model must treat as reference-only.
 *
 * Why the system message and not the user message: when the rolling
 * context sat alongside `Original bullets:` in the user message, small
 * instruct models (Qwen2.5-1.5B in particular) read the prior section's
 * preview line as another bullet to echo into the output. Moving it to
 * the system message — wrapped in an explicit "reference only, never echo
 * into your output" guardrail — makes the boundary categorical: the user
 * message is the input to rewrite, the system message is the world the
 * model rewrites within. See #67 follow-up where this misfire was caught.
 */
export function buildSectionSystemPrompt(
  context?: string,
  steering?: RewriteSteering,
): string {
  const base =
    !context || context.trim().length === 0
      ? SECTION_REWRITE_SYSTEM_PROMPT
      : `${SECTION_REWRITE_SYSTEM_PROMPT}

Earlier sections of this résumé have already been rewritten. The user's NEXT message contains a NEW section's bullets — only rewrite THOSE. Do not include content from earlier sections in your output.

Context from earlier sections (reference only — never echo into your output):
${context.trim()}`;
  return `${base}${buildSteeringSuffix(steering)}`;
}

/**
 * Optional knobs the chain-of-sections orchestrator (#67) threads through to
 * each per-section call. Today only `context` is wired — a single
 * pre-formatted brief (used-verb constraint + used-phrase constraint + a
 * prior-section preview) that gets folded into the SYSTEM message as
 * reference-only context. Defaults to undefined, so every existing call site
 * (single-section rewrite, eval harness) behaves bit-identically to the
 * Phase 1 path.
 */
export interface SectionRewriteOptions {
  /** Rolling soft-constraint brief from earlier sections in the chain. */
  context?: string;
  /**
   * User-supplied rewrite steering (#210): freeform instructions + an optional
   * page-length target. Folded into the SYSTEM message as a suffix after the
   * guardrails. Undefined → no behaviour change.
   */
  steering?: RewriteSteering;
}

export interface SectionRewriteResult {
  /** The rewritten bullets (M may differ from N). */
  bullets: string[];
  /** True iff every input number survived and none were invented. */
  numbersPreserved: boolean;
  /** Numeric tokens that did not survive (UI surfaces these inline). */
  droppedNumbers: string[];
  /** Numeric tokens that appeared from nowhere (UI surfaces these inline). */
  addedNumbers: string[];
}

/**
 * Per-model one-shot guard for `webllm_first_section_rewrite`. Each model's
 * first successful section rewrite fires the event exactly once per page so
 * the funnel can compare "X loads → Y first section rewrites" per model.
 */
const firstSectionRewriteFiredFor = new Set<string>();

/**
 * Rewrite a whole section of resume bullets using a loaded WebLLM engine.
 *
 * Pure over `engine` — the engine is passed in so tests can supply a stub
 * implementing the `WebLlmEngine` contract without touching the real model.
 *
 * `modelId` is required for model-dimensioned telemetry; the engine itself
 * doesn't expose its model id, so the caller has to thread it through. In
 * practice this is the same value that was passed to `loadEngine(modelId,
 * …)` to acquire the engine.
 *
 * Output handling: split on newlines, run each line through the shared
 * cleanRewriteLine helper (strips `Rewritten:` prefix echoes, surrounding
 * quotes, and list markers), and keep every non-empty result. M may differ
 * from N — that's the whole point of section rewrite, not a failure mode.
 *
 * Telemetry: `webllm_section_rewrite_started` fires unconditionally;
 * `webllm_section_rewrite_completed` fires with the bullet counts and
 * numbersPreserved boolean once the model returns. `webllm_first_section_rewrite`
 * is a separate one-shot flag from the per-bullet first-rewrite key,
 * preserving funnel continuity for both paths. All three events carry the
 * `model` dimension.
 */
export async function rewriteSectionWithLlm(
  bullets: readonly string[],
  engine: WebLlmEngine,
  modelId: string,
  options: SectionRewriteOptions = {},
): Promise<SectionRewriteResult> {
  trackWebllmSectionRewriteStarted({
    model: modelId,
    inputBulletCount: bullets.length,
  });

  // Acquire so a concurrent picker switch can't `.unload()` this engine
  // mid-stream. Paired in `finally` so an error path still releases.
  acquireInference(modelId);
  try {
    const response = await engine.chat.completions.create({
      messages: [
        {
          role: "system",
          content: buildSectionSystemPrompt(options.context, options.steering),
        },
        { role: "user", content: buildSectionUserPrompt(bullets) },
      ],
      temperature: 0.3,
      max_tokens: sectionMaxTokens(bullets.length),
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const rewrittenBullets = raw
      .split("\n")
      .map((line) => cleanRewriteLine(line))
      .filter((line) => line.length > 0);

    const preservation = checkNumbersPreserved(bullets, rewrittenBullets);

    trackWebllmSectionRewriteCompleted({
      model: modelId,
      inputBulletCount: bullets.length,
      outputBulletCount: rewrittenBullets.length,
      numbersPreserved: preservation.ok,
    });

    // Same gating as the per-bullet path: only count the first *successful*
    // section rewrite (one with at least one bullet) so a null/empty model
    // response doesn't pollute the conversion funnel.
    if (
      !firstSectionRewriteFiredFor.has(modelId) &&
      rewrittenBullets.length > 0
    ) {
      firstSectionRewriteFiredFor.add(modelId);
      trackWebllmFirstSectionRewrite({ model: modelId });
    }

    return {
      bullets: rewrittenBullets,
      numbersPreserved: preservation.ok,
      droppedNumbers: preservation.dropped,
      addedNumbers: preservation.added,
    };
  } finally {
    releaseInference(modelId);
  }
}

/** Test-only: drop the per-model one-shot telemetry flags between tests. */
export function _resetSectionRewriteFlagsForTesting(): void {
  firstSectionRewriteFiredFor.clear();
}

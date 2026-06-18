// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import {
  trackWebllmFirstSectionRewrite,
  trackWebllmSectionRewriteCompleted,
  trackWebllmSectionRewriteStarted,
} from "../analytics.ts";
import { cleanRewriteLine } from "./post-process.ts";
import { checkNumbersPreserved } from "./preserve-numbers.ts";
import type { WebLlmEngine } from "./types.ts";

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

let firstSectionRewriteFired = false;

/**
 * Rewrite a whole section of resume bullets using a loaded WebLLM engine.
 *
 * Pure over `engine` — the engine is passed in so tests can supply a stub
 * implementing the `WebLlmEngine` contract without touching the real model.
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
 * preserving funnel continuity for both paths.
 */
export async function rewriteSectionWithLlm(
  bullets: readonly string[],
  engine: WebLlmEngine,
): Promise<SectionRewriteResult> {
  trackWebllmSectionRewriteStarted({ inputBulletCount: bullets.length });

  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SECTION_REWRITE_SYSTEM_PROMPT },
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
    inputBulletCount: bullets.length,
    outputBulletCount: rewrittenBullets.length,
    numbersPreserved: preservation.ok,
  });

  // Same gating as the per-bullet path: only count the first *successful*
  // section rewrite (one with at least one bullet) so a null/empty model
  // response doesn't pollute the conversion funnel.
  if (!firstSectionRewriteFired && rewrittenBullets.length > 0) {
    firstSectionRewriteFired = true;
    trackWebllmFirstSectionRewrite();
  }

  return {
    bullets: rewrittenBullets,
    numbersPreserved: preservation.ok,
    droppedNumbers: preservation.dropped,
    addedNumbers: preservation.added,
  };
}

/** Test-only: drop the one-shot telemetry flag between tests. */
export function _resetSectionRewriteFlagsForTesting(): void {
  firstSectionRewriteFired = false;
}

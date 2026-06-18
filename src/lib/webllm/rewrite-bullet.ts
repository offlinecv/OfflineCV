// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { trackWebllmFirstRewrite } from "../analytics.ts";
import { cleanRewriteLine } from "./post-process.ts";
import type { WebLlmEngine } from "./types.ts";

/**
 * Prompt template. Single source of truth — the UI's "What's happening?"
 * disclosure copy paraphrases these rules so users can see what the model
 * is actually being asked to do.
 *
 * Tuned for Qwen2-1.5B-Instruct; smaller models need the rules stated more
 * emphatically than a frontier model would. Expect 5–10 iterations.
 */
export const BULLET_REWRITE_SYSTEM_PROMPT = `You are rewriting a single resume bullet to be more specific and outcome-oriented.
Rules:
- Keep it to one line.
- Lead with a strong action verb.
- Preserve any concrete numbers from the original exactly. Do not invent metrics.
- If the original is already strong, return it unchanged.
- Output only the rewritten bullet. No preamble, no explanation, no quotes.`;

export function buildUserPrompt(bullet: string): string {
  return `Original: ${bullet.trim()}\nRewritten:`;
}

let firstRewriteFired = false;

/**
 * Rewrite a single resume bullet using a loaded WebLLM engine.
 *
 * Pure over `engine` — the engine is passed in so tests can supply a stub
 * implementing the `WebLlmEngine` contract without touching the real model.
 *
 * Post-processing: strip a leading `"Rewritten:"` (the model sometimes
 * echoes the prefix), drop quotes, and keep only the first non-empty line
 * (the prompt asks for one line; the post-process enforces it).
 */
export async function rewriteBulletWithLlm(
  bullet: string,
  engine: WebLlmEngine,
): Promise<string> {
  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: BULLET_REWRITE_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(bullet) },
    ],
    temperature: 0.3,
    max_tokens: 120,
  });
  const raw = response.choices[0]?.message?.content ?? "";
  const cleaned = postProcess(raw);
  // Only count it as a "first rewrite" when the model actually returned
  // usable output. A null/empty response is a failure mode, not a funnel
  // step worth measuring against download conversion.
  if (!firstRewriteFired && cleaned.length > 0) {
    firstRewriteFired = true;
    trackWebllmFirstRewrite();
  }
  return cleaned;
}

function postProcess(raw: string): string {
  // Per-bullet path: clean every line then keep the first non-empty result.
  // Section path uses cleanRewriteLine the same way but keeps all lines —
  // see rewrite-section.ts.
  for (const line of raw.split("\n")) {
    const cleaned = cleanRewriteLine(line);
    if (cleaned.length > 0) return cleaned;
  }
  return "";
}

/** Test-only: drop the one-shot telemetry flag between tests. */
export function _resetRewriteFlagsForTesting(): void {
  firstRewriteFired = false;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Rewrite steering (issue #210) — the user's freeform intent + a page-length
 * target, folded into the rewrite system prompt as a SUFFIX appended after
 * the base guardrails.
 *
 * Why a suffix and not a template: the base prompts
 * (`SECTION_REWRITE_SYSTEM_PROMPT` / `SUMMARY_REWRITE_SYSTEM_PROMPT`) carry the
 * number-preservation / no-fabrication guardrails. Interleaving user text into
 * those rules risks the small instruct model dropping a guardrail. Appending
 * the steering AFTER the rules keeps them intact and just layers intent on top
 * — the same shape Recruidea uses for `custom_instructions` (a system-message
 * suffix), see issue #210 references.
 *
 * Both halves are independent and optional:
 *   - `userInstructions` → appended verbatim ("The user has these additional
 *     instructions: …"). Empty/blank → contributes nothing.
 *   - `pageTarget` → a derived length-budget sentence PLUS explicit
 *     recency-weighted compression guidance (compress/combine OLDER experience
 *     entries preferentially, so the budget is spent on recent roles). Unset →
 *     contributes nothing.
 *
 * WebLLM is text-only and rewrites section-by-section, so it never sees PDF
 * pagination — `pageTarget` is therefore approximated as a per-page length
 * budget, NOT enforced as true pagination (issue #210 "Out of scope").
 */

/** A page-length target. 1 = tightest budget, 3 = loosest. */
export type PageTarget = 1 | 2 | 3;

export interface RewriteSteering {
  /** The user's freeform "what I want from this rewrite" text. */
  userInstructions?: string;
  /** Optional page-length target driving a per-page length budget. */
  pageTarget?: PageTarget;
}

/**
 * Per-page length budget + recency-compression guidance, keyed by target.
 *
 * The word/bullet caps are deliberately soft ("about", "under ~N words") —
 * a small instruct model follows directional guidance far better than a hard
 * count it will silently violate. Each tier carries the same
 * compress-older-entries-first instruction so a tightened budget trims the
 * least-relevant history rather than uniformly gutting recent roles.
 */
const PAGE_BUDGET: Record<PageTarget, string> = {
  1: "Target a one-page résumé: keep each bullet under ~15 words and at most 3 to 4 bullets per role. Compress or combine older experience entries preferentially so the limited space goes to the most recent, relevant roles.",
  2: "Target a two-page résumé: keep bullets concise (under ~22 words) with about 4 to 5 bullets per role. Where space is tight, compress or combine older experience entries before trimming recent ones.",
  3: "Target a three-page résumé: there is room for fuller detail, but still cut filler. If any trimming is needed, compress or combine older experience entries first.",
};

/**
 * Build the steering suffix appended to a rewrite system prompt.
 *
 * Returns `""` when there's nothing to add (no steering, blank instructions,
 * no page target) — callers append unconditionally, so an empty string means
 * the prompt is byte-identical to the pre-#210 behaviour (no output change).
 *
 * Order: the length budget first (it constrains the shape), then the user's
 * verbatim instructions last (most salient position for a small model). Each
 * present part is separated by a blank line and the whole block is preceded by
 * a blank line so it reads as a distinct section after the guardrails.
 */
export function buildSteeringSuffix(steering?: RewriteSteering): string {
  if (!steering) return "";

  const parts: string[] = [];

  if (steering.pageTarget !== undefined) {
    parts.push(PAGE_BUDGET[steering.pageTarget]);
  }

  const instructions = steering.userInstructions?.trim();
  if (instructions) {
    parts.push(`The user has these additional instructions: ${instructions}`);
  }

  if (parts.length === 0) return "";

  return `\n\n${parts.join("\n\n")}`;
}

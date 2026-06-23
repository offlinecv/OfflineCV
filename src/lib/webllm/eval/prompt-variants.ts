// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { SECTION_REWRITE_SYSTEM_PROMPT } from "../rewrite-section.ts";
import type { PromptVariant } from "./types.ts";

/**
 * Prompt variants the eval compares.
 *
 * `baseline` is the SHIPPED system prompt in `rewrite-section.ts` —
 * imported directly so a tweak there is automatically reflected in the
 * baseline column of the eval. The other variants are deliberately small
 * deltas (one or two rule changes) so a regression in any one criterion
 * traces cleanly to a single prompt change rather than a wholesale
 * rewrite.
 *
 * Add a variant by appending here; the runner enumerates this array.
 * Variant ids must be stable kebab-case so committed reports remain
 * diffable across runs.
 */
export const PROMPT_VARIANTS: readonly PromptVariant[] = [
  {
    id: "baseline",
    label: "Baseline (shipped)",
    systemPrompt: SECTION_REWRITE_SYSTEM_PROMPT,
  },
  {
    id: "terse",
    label: "Terse (rules-only)",
    systemPrompt: `Rewrite each resume bullet to be more specific and outcome-oriented.
- One bullet per line. No numbering, markers, quotes, or preamble.
- Start each bullet with a strong action verb.
- Preserve every number from the input EXACTLY.
- Merge weak duplicates. Drop pure filler. Vary the verbs.`,
  },
  {
    id: "examples-led",
    label: "Examples-led (few-shot)",
    systemPrompt: `You are rewriting resume bullets to be more specific and outcome-oriented.

Rules:
- One bullet per line. No numbering. No bullet markers. No quotes. No preamble.
- Lead every bullet with a strong action verb.
- Preserve every concrete number EXACTLY. Do not invent numbers.
- Merge weak duplicates. Drop pure filler. Vary verbs across bullets.

Example weak → strong:
- "Helped with marketing things" → "Drove a 4-touchpoint nurture sequence that lifted lead-to-MQL conversion 12%."
- "Worked on backend stuff" → "Migrated the order-processing pipeline to Kafka, cutting median latency 38%."`,
  },
];

/** Look up a variant by id. */
export function getVariantById(id: string): PromptVariant | undefined {
  return PROMPT_VARIANTS.find((v) => v.id === id);
}

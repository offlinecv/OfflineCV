// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * rewrite-guardrails.ts — the rewrite rules, written once (#609).
 *
 * offlinecv now builds THREE rewrite prompts from the same set of rules:
 *
 *   1. `SECTION_REWRITE_SYSTEM_PROMPT` — on-device, one section of bullets.
 *   2. `SUMMARY_REWRITE_SYSTEM_PROMPT` — on-device, the summary paragraph.
 *   3. `buildExportableRewritePrompt` — the prompt the user copies out to
 *      whatever model they already pay for, applied to the whole résumé.
 *
 * What differs between them is the **I/O contract**: (1) and (2) are tuned for
 * a 1–3B instruct model and carry a rigid line-per-bullet / single-paragraph
 * output rule, and (3) hands a capable model an entire document. What must NOT
 * differ is the guardrails — number preservation and no fabrication are the
 * reason a user can trust any of the three, and a rule stated in three places
 * disagrees within a release. This module is the one place each rule is
 * written; the three prompts compose it and add only their own contract.
 *
 * These strings are model input, so they are frozen artifacts, not copy: an
 * edit here changes the behaviour of every shipped rewrite path at once. That
 * is the point — but it means `rewrite-guardrails.test.ts` pins the two
 * on-device prompts against literals captured BEFORE the extraction, so a
 * wording change can never ride along with an unrelated refactor.
 *
 * Pure: no imports, no I/O, no clock. Follows `src/lib/score/score.ts` as the
 * zero-dep lib-module exemplar.
 */

/**
 * The single most important rule in the tree, and the one #609 required to
 * have exactly one definition.
 *
 * The deterministic `checkNumbersPreserved` set diff is what actually
 * catches a violation after the fact; this sentence is what stops the model
 * producing one. Both halves are needed — the check can only warn, it cannot
 * repair — so neither is redundant with the other.
 */
export const PRESERVE_NUMBERS_RULE =
  "Preserve every concrete number from the input EXACTLY. Do not invent new numbers or metrics.";

/**
 * The whole-document generalisation of {@link PRESERVE_NUMBERS_RULE}'s second
 * clause, for the exported prompt only.
 *
 * The on-device prompts do not carry it and must not start: they see one
 * section at a time, and a section rewrite has no opportunity to invent an
 * employer or a degree because it is never handed the fields that hold them. A
 * frontier model handed the ENTIRE résumé does have that opportunity, and
 * "make my résumé stronger" is exactly the instruction under which a model
 * embellishes a title.
 */
export const NO_FABRICATION_RULE =
  "Do not invent employers, job titles, dates, degrees, or credentials. Every fact in your output must already appear in the input.";

/** Section + exported prompt. Not the summary — a paragraph has no bullets. */
export const STRONG_VERB_RULE =
  "Lead every bullet with a strong action verb.";

/** Section + exported prompt. Guards against a wall of "Led …, Led …, Led …". */
export const VARY_VERBS_RULE =
  "Vary the action verbs across bullets — don't start every line the same way.";

/** Section + exported prompt. The licence to restructure, not just reword. */
export const MERGE_AND_PRUNE_RULE =
  "You may merge two weak bullets into one strong bullet, drop pure filler, or reorder for emphasis.";

/** Summary + exported prompt. */
export const SUMMARY_LEAD_RULE =
  "Lead with the strongest concrete claim (years of experience, primary domain, or signature outcome).";

/** Summary + exported prompt. */
export const DROP_FILLER_RULE =
  'Drop generic filler ("hard-working", "team player", "passionate"). Keep specifics.';

/**
 * "Leave it alone if it's already good" — stated for whatever unit the prompt
 * is about. Parameterised rather than triplicated because the rule is one rule;
 * only the noun changes, and a divergence between the three wordings would be
 * an accident every time.
 *
 * `subject` carries its own article ("a bullet", "the summary") — English does
 * not let the caller supply a bare noun and get both "a bullet" and "the
 * summary" out of one template.
 */
export function keepIfAlreadyStrongRule(subject: string): string {
  return `If ${subject} is already strong, keep it unchanged.`;
}

/** The opening task line shared by the two on-device prompts. */
export function rewriteTaskLine(object: string): string {
  return `You are rewriting ${object} to be more specific and outcome-oriented.`;
}

/**
 * Assemble a task line + a `Rules:` block. The `- ` markers live here so a rule
 * constant is a plain sentence — the exported prompt renders the same sentences
 * into its own list without stripping anything back off.
 */
export function composeRulesPrompt(
  taskLine: string,
  rules: readonly string[],
): string {
  return `${taskLine}\nRules:\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

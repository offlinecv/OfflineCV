// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The refactor gate for #609's guardrail extraction.
 *
 * `SECTION_REWRITE_SYSTEM_PROMPT` and `SUMMARY_REWRITE_SYSTEM_PROMPT` stopped
 * being string literals and became compositions of `rewrite-guardrails.ts`.
 * Both are model INPUT on the shipped on-device path, so a single changed
 * character is a behaviour change for every user who clicks Rewrite — the kind
 * that produces no error, no failing test elsewhere, and no way to notice
 * except by reading eval output weeks later.
 *
 * The two literals below were captured from `git show` of the pre-extraction
 * files (`rewrite-section.ts:28`, `rewrite-summary.ts:39` at 0571a82) and are
 * deliberately written out in full rather than derived from the constants they
 * are meant to check. A test that rebuilt the expected string from the same
 * exports it is testing would pass for any wording whatsoever — it would only
 * prove that `composeRulesPrompt` is deterministic, which is not the claim.
 *
 * If you are here because this test failed after you edited a rule: that is the
 * test working. Deciding to change a shipped prompt is fine; doing it as a side
 * effect of touching something else is what this blocks. Update the literal in
 * the same commit that changes the rule, and say so in the PR.
 */

import { describe, it, expect } from "vitest";
import {
  buildSectionSystemPrompt,
  SECTION_REWRITE_SYSTEM_PROMPT,
} from "./rewrite-section.ts";
import {
  buildSummarySystemPrompt,
  SUMMARY_REWRITE_SYSTEM_PROMPT,
} from "./rewrite-summary.ts";
import {
  NO_FABRICATION_RULE,
  PRESERVE_NUMBERS_RULE,
  composeRulesPrompt,
  keepIfAlreadyStrongRule,
  rewriteTaskLine,
} from "./rewrite-guardrails.ts";

/** Verbatim `SECTION_REWRITE_SYSTEM_PROMPT` as it shipped before #609. */
const SECTION_PROMPT_BEFORE_609 = `You are rewriting a list of resume bullets to be more specific and outcome-oriented.
Rules:
- Output one bullet per line. No numbering. No bullet markers. No quotes. No preamble.
- Lead every bullet with a strong action verb.
- Preserve every concrete number from the input EXACTLY. Do not invent new numbers or metrics.
- You may merge two weak bullets into one strong bullet, drop pure filler, or reorder for emphasis.
- Vary the action verbs across bullets — don't start every line the same way.
- If a bullet is already strong, keep it unchanged.`;

/** Verbatim `SUMMARY_REWRITE_SYSTEM_PROMPT` as it shipped before #609. */
const SUMMARY_PROMPT_BEFORE_609 = `You are rewriting a resume summary to be more specific and outcome-oriented.
Rules:
- Output a single paragraph of 2–3 sentences. No bullet points. No numbering. No quotes. No preamble.
- Lead with the strongest concrete claim (years of experience, primary domain, or signature outcome).
- Preserve every concrete number from the input EXACTLY. Do not invent new numbers or metrics.
- Drop generic filler ("hard-working", "team player", "passionate"). Keep specifics.
- If the summary is already strong, keep it unchanged.`;

describe("shipped on-device prompts survive the guardrail extraction", () => {
  it("SECTION_REWRITE_SYSTEM_PROMPT is byte-identical to its pre-#609 value", () => {
    expect(SECTION_REWRITE_SYSTEM_PROMPT).toBe(SECTION_PROMPT_BEFORE_609);
  });

  it("SUMMARY_REWRITE_SYSTEM_PROMPT is byte-identical to its pre-#609 value", () => {
    expect(SUMMARY_REWRITE_SYSTEM_PROMPT).toBe(SUMMARY_PROMPT_BEFORE_609);
  });

  // The constants are what the prompts are BUILT from, but the on-device path
  // calls the builders, not the constants — so the extraction is only provably
  // invisible if what actually reaches the engine is unchanged too. With no
  // context and no steering both builders are the bare prompt.
  it("the section builder's no-context, no-steering output is unchanged", () => {
    expect(buildSectionSystemPrompt()).toBe(SECTION_PROMPT_BEFORE_609);
  });

  it("the summary builder's no-context, no-steering output is unchanged", () => {
    expect(buildSummarySystemPrompt()).toBe(SUMMARY_PROMPT_BEFORE_609);
  });

  // The steering suffix is appended AFTER the base prompt; #609 must not have
  // moved that seam. A page target is the shortest steering that produces one.
  it("a steered section prompt is still the base prompt plus a suffix", () => {
    const steered = buildSectionSystemPrompt(undefined, { pageTarget: 1 });
    expect(steered.startsWith(`${SECTION_PROMPT_BEFORE_609}\n\n`)).toBe(true);
  });
});

describe("the guardrail constants", () => {
  it("state the number-preservation rule exactly once, and both prompts carry it", () => {
    expect(SECTION_REWRITE_SYSTEM_PROMPT).toContain(PRESERVE_NUMBERS_RULE);
    expect(SUMMARY_REWRITE_SYSTEM_PROMPT).toContain(PRESERVE_NUMBERS_RULE);
  });

  // The whole-document rule is for the EXPORTED prompt only. Leaking it into a
  // shipped prompt would be a silent behaviour change on the on-device path —
  // which is exactly what the byte-identity tests above would catch, so this
  // asserts the intent directly rather than leaving it to a diff.
  it("keeps the whole-document no-fabrication rule out of the on-device prompts", () => {
    expect(SECTION_REWRITE_SYSTEM_PROMPT).not.toContain(NO_FABRICATION_RULE);
    expect(SUMMARY_REWRITE_SYSTEM_PROMPT).not.toContain(NO_FABRICATION_RULE);
  });

  it("renders rules as a dash list under a Rules: header", () => {
    expect(composeRulesPrompt("Task line.", ["first rule", "second rule"])).toBe(
      "Task line.\nRules:\n- first rule\n- second rule",
    );
  });

  it("carries the subject's own article into the already-strong rule", () => {
    expect(keepIfAlreadyStrongRule("a bullet")).toBe(
      "If a bullet is already strong, keep it unchanged.",
    );
    expect(keepIfAlreadyStrongRule("the summary")).toBe(
      "If the summary is already strong, keep it unchanged.",
    );
  });

  it("builds the task line from its object", () => {
    expect(rewriteTaskLine("a resume summary")).toBe(
      "You are rewriting a resume summary to be more specific and outcome-oriented.",
    );
  });
});

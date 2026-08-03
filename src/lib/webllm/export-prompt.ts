// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * export-prompt.ts — the rewrite prompt the user takes ELSEWHERE (#609).
 *
 * The on-device pass is the right default: it is the only rewrite that keeps
 * the résumé text on the device, and it is what makes this project's custody
 * claim true. It is also, straightforwardly, a 1–3B instruct model, which is
 * the weakest rewriter most users have access to — someone with a frontier
 * model open in the next tab has a far better one and, before this module, no
 * way to use it without improvising a prompt from scratch and losing every
 * guardrail this repo has tuned.
 *
 * So: hand them the prompt. A clipboard write is local — nothing here fetches,
 * and where the user takes the text afterwards is their own deliberate choice
 * rather than our default.
 *
 * ── Three properties this string has to hold ──
 *
 * 1. **No résumé content.** The user brings their own document to the external
 *    model; this is INSTRUCTIONS ONLY. Nothing derived from a bullet, a name,
 *    an employer or a date may appear here — `export-prompt.test.ts` asserts
 *    the absence against a full fixture résumé. The one résumé-derived thing
 *    that does appear is a COUNT (see {@link describeShape}), which names no
 *    field value. Copying the reconstructed résumé text is a genuinely useful
 *    follow-up and a deliberately separate one: it needs its own control and
 *    its own label, never this one.
 *
 * 2. **The same guardrails as the shipped prompts.** Every rule comes from
 *    `rewrite-guardrails.ts`, so `Preserve every concrete number …` has exactly
 *    one definition in the tree and cannot drift between the path we run and
 *    the path we hand out. What differs is the I/O contract: the shipped
 *    prompts are tuned for a small model rewriting ONE section, and their rigid
 *    line-per-bullet rule would hobble a capable model handed a whole document.
 *
 * 3. **The user's live steering.** `buildSteeringSuffix` is called — not
 *    restated — so a user who picked "1 page" and typed instructions gets a
 *    prompt carrying exactly what the on-device run would have carried. Passing
 *    no `units` also means the per-line findings channel (#608) contributes
 *    nothing, which is deliberate: a finding names a specific line, and naming
 *    the line means quoting it, which would put résumé text on the clipboard
 *    and break property 1. Findings become possible in the follow-up that
 *    copies the résumé text alongside.
 *
 * Pure: no I/O, no clock, no React. `src/lib/score/score.ts` is the exemplar.
 */

import type { SectionInput } from "./rewrite-resume.ts";
import {
  composeRulesPrompt,
  DROP_FILLER_RULE,
  keepIfAlreadyStrongRule,
  MERGE_AND_PRUNE_RULE,
  NO_FABRICATION_RULE,
  PRESERVE_NUMBERS_RULE,
  rewriteTaskLine,
  STRONG_VERB_RULE,
  SUMMARY_LEAD_RULE,
  VARY_VERBS_RULE,
} from "./rewrite-guardrails.ts";
import { buildSteeringSuffix, type RewriteSteering } from "./steering.ts";

/**
 * The whole-document contract, and the only rule here with no counterpart in
 * the shipped prompts — because the shipped prompts never see a whole document.
 * A section rewrite cannot drop a section it was never given; a frontier model
 * handed the entire résumé can, and "make this stronger" is exactly the
 * instruction under which one quietly disappears.
 */
const WHOLE_DOCUMENT_CONTRACT =
  "Rewrite the entire résumé and return it in full, keeping the original section order and headings. Do not add sections that are not in the input, and do not drop one.";

/**
 * The output shape. Deliberately a preference, not the shipped prompts' rigid
 * "no markers, no preamble" contract — that contract exists because a 1.5B
 * model breaks each clause of it, and imposing it on a capable model buys
 * nothing. What it does buy is the trip home: the user has to move this output
 * back into offlinecv's inline editor field by field, and plain text with one
 * bullet per line is what makes that mechanical rather than a re-typing job.
 */
const PLAIN_TEXT_PREFERENCE =
  "Return plain text — no markdown, no tables — with one bullet per line, so each line can be pasted straight back into a résumé editor.";

/** Closing instruction. Last, because it is the one thing the USER must do. */
const ATTACH_NOTE =
  "Paste your résumé below, or attach it, and reply with the rewritten version.";

interface ResumeShape {
  hasSummary: boolean;
  roleCount: number;
  bulletCount: number;
}

function shapeOf(sections: readonly SectionInput[]): ResumeShape {
  let hasSummary = false;
  let roleCount = 0;
  let bulletCount = 0;
  for (const section of sections) {
    if (section.kind === "summary") {
      if (section.text.trim().length > 0) hasSummary = true;
      continue;
    }
    const bullets = section.bullets.filter((b) => b.trim().length > 0);
    if (bullets.length === 0) continue;
    roleCount += 1;
    bulletCount += bullets.length;
  }
  return { hasSummary, roleCount, bulletCount };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One sentence of résumé-derived context — counts only, never a field value
 * (see property 1 in the module docblock). This is what makes the copied text
 * *this résumé's* prompt rather than a template out of the docs: a model told
 * to expect three roles behaves differently from one told to expect eleven,
 * and a user who reads "1 role" here learns something real about our parse
 * before they trust the rest of the app's output.
 *
 * Returns `null` when there is nothing to describe, so the caller omits the
 * line rather than emitting "read this résumé as nothing".
 */
export function describeShape(sections: readonly SectionInput[]): string | null {
  const { hasSummary, roleCount, bulletCount } = shapeOf(sections);
  const parts: string[] = [];
  if (hasSummary) parts.push("a summary paragraph");
  if (roleCount > 0) {
    parts.push(
      `${plural(roleCount, "role")} carrying ${plural(bulletCount, "bullet")} between them`,
    );
  }
  if (parts.length === 0) return null;
  return `For scale: offlinecv read this résumé as ${parts.join(" and ")}. That is what our text extractor saw, which is not always what the document holds — work from the document itself.`;
}

/**
 * Build the prompt a user copies out to an external model.
 *
 * `sections` supplies SHAPE ONLY (counts — see {@link describeShape}).
 * `steering` is the very object the on-device run would have used, so the
 * copied prompt and the button beside it carry the same intent; its `findings`
 * are ignored by construction (no `units` passed — see the module docblock).
 */
export function buildExportableRewritePrompt(
  sections: readonly SectionInput[],
  steering?: RewriteSteering,
): string {
  const rules = composeRulesPrompt(rewriteTaskLine("a résumé"), [
    WHOLE_DOCUMENT_CONTRACT,
    PRESERVE_NUMBERS_RULE,
    NO_FABRICATION_RULE,
    STRONG_VERB_RULE,
    VARY_VERBS_RULE,
    MERGE_AND_PRUNE_RULE,
    `Summary paragraph — ${SUMMARY_LEAD_RULE}`,
    DROP_FILLER_RULE,
    keepIfAlreadyStrongRule("a line"),
    PLAIN_TEXT_PREFERENCE,
  ]);

  // The shape line goes BEFORE the steering, not after: `buildSteeringSuffix`
  // puts the user's own words last on purpose (steering.ts — most salient
  // position, and the only part they typed seconds ago with a specific intent),
  // and sliding a sentence about our parser in after them would undo that. Its
  // return value is "" or a "\n\n"-prefixed block, so the blank-line seam is its
  // contract, not ours to re-derive.
  const shape = describeShape(sections);
  const context = shape === null ? rules : `${rules}\n\n${shape}`;
  return `${context}${buildSteeringSuffix(steering)}\n\n${ATTACH_NOTE}`;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 * (see issue #210).
 *
 * All three parts are independent and optional:
 *   - `userInstructions` → appended verbatim ("The user has these additional
 *     instructions: …"). Empty/blank → contributes nothing.
 *   - `pageTarget` → a derived length-budget sentence PLUS explicit
 *     recency-weighted compression guidance (compress/combine OLDER experience
 *     entries preferentially, so the budget is spent on recent roles). Unset →
 *     contributes nothing.
 *   - `findings` → the app's OWN analysis of specific lines (#608). Unset, or
 *     holding nothing for the section being rewritten → contributes nothing.
 *
 * WebLLM is text-only and rewrites section-by-section, so it never sees PDF
 * pagination — `pageTarget` is therefore approximated as a per-page length
 * budget, NOT enforced as true pagination (issue #210 "Out of scope").
 */

import { normalizeBulletText } from "../score/group-bullets.ts";

/** A page-length target. 1 = tightest budget, 3 = loosest. */
export type PageTarget = 1 | 2 | 3;

export interface RewriteSteering {
  /** The user's freeform "what I want from this rewrite" text. */
  userInstructions?: string;
  /** Optional page-length target driving a per-page length budget. */
  pageTarget?: PageTarget;
  /**
   * Findings the app already surfaced to the user, per unit of text (#608).
   * Keyed by the bullet / summary text they were computed against, normalised
   * through {@link findingsKey} so a leading marker or a whitespace difference
   * between the critique's copy of a line and the rewriter's does not lose the
   * join.
   *
   * Before #608 this channel did not exist and the rewrite ran as if the app
   * had never analysed the document: a user could read a critique saying "this
   * bullet has no quantification", click Rewrite, and get a rewrite that
   * addressed none of it, because the rewriter was never told.
   *
   * Scoping is the whole design. {@link buildSteeringSuffix} emits ONLY the
   * entries matching the units of the section being rewritten — never the whole
   * résumé's findings on every section. Dumping all of them into each prompt is
   * the failure mode `PRIOR_PREVIEW_CHAR_CAP` already warns about (small
   * instruct models lose the actual instruction when the prompt balloons), and
   * it would make this feature a net negative.
   */
  findings?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The lookup key for {@link RewriteSteering.findings} — lower-cased, leading
 * bullet marker stripped, internal whitespace collapsed.
 *
 * The two sides of this join are produced by different subsystems from
 * different copies of the same line: `critiqueResumeWithLlm` echoes the bullet
 * back through the model (which routinely re-wraps or re-punctuates whitespace)
 * while the rewriter reads it straight off the parsed résumé. Matching on raw
 * text loses findings for reasons that have nothing to do with the résumé.
 *
 * Reuses the scorer's `normalizeBulletText` rather than hand-rolling a second
 * normaliser — it is the same "is this the same bullet" question
 * `groupBulletsByExperience` and `bullet-id.ts` already answer, and a divergent
 * second answer here would be invisible until a finding silently went missing.
 */
export function findingsKey(text: string): string {
  return normalizeBulletText(text);
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
 * Preamble for the findings block (#608), and the anti-fabrication guardrail
 * that has to ride with it.
 *
 * The suggestions come from `critiqueResumeWithLlm`, which is free to write
 * "quantify this — e.g. reduced latency by 40%". That number is an ILLUSTRATION
 * the judge model invented, not a fact about the candidate, and a rewriter told
 * to "address the note" will happily copy it into the résumé. The base prompt's
 * "do not invent new numbers" rule already covers this in principle, but the
 * notes arrive AFTER it and name numbers concretely, so the rule is restated
 * where the temptation is. `checkNumbersPreserved` catches a leak either way —
 * this is about not manufacturing one in the first place.
 */
const FINDINGS_PREAMBLE =
  "A quality review of this résumé flagged the lines below. Address each note when you rewrite that line. The notes are guidance about the WRITING, not facts about the candidate: never copy a number, employer, or achievement out of a note into your output.";

/**
 * Render the findings that apply to `units`, numbered to match the user
 * message's `1.`-based list, or `null` when none apply.
 *
 * Referencing bullets BY NUMBER rather than by quoting their text is
 * deliberate: the section user prompt (`buildSectionUserPrompt`) already
 * numbers the same array in the same order, so the index is unambiguous — and
 * quoting a bullet inside the system message is exactly what made small models
 * echo the rolling-context preview into their output (see
 * `buildSectionSystemPrompt`'s docblock). It is also markedly shorter, which is
 * the budget this whole block has to justify.
 */
function renderFindings(
  findings: ReadonlyMap<string, readonly string[]>,
  units: readonly string[],
  unitNoun: string,
): string | null {
  // A single-unit call (the summary) has no list to index into, so the ordinal
  // would read "Summary 1" and imply a second one exists.
  const single = units.length === 1;
  const lines: string[] = [];
  units.forEach((unit, i) => {
    const notes = findings.get(findingsKey(unit));
    if (notes === undefined || notes.length === 0) return;
    const label = single ? unitNoun : `${unitNoun} ${i + 1}`;
    lines.push(`- ${label}: ${notes.join("; ")}`);
  });
  if (lines.length === 0) return null;
  return `${FINDINGS_PREAMBLE}\n${lines.join("\n")}`;
}

/**
 * Build the steering suffix appended to a rewrite system prompt.
 *
 * Returns `""` when there's nothing to add (no steering, blank instructions,
 * no page target, no finding matching this section) — callers append
 * unconditionally, so an empty string means the prompt is byte-identical to the
 * pre-#210 behaviour (no output change).
 *
 * `units` are the texts this call is about to rewrite, in the same order the
 * user message numbers them: a section's bullets, or a one-element array
 * holding the summary. They exist ONLY to scope `steering.findings` — omit them
 * and the findings channel contributes nothing, which keeps every pre-#608
 * caller (the eval harness, a direct single-section rewrite) byte-identical.
 *
 * Order: the length budget first (it constrains the shape), then the findings,
 * then the user's verbatim instructions last (most salient position for a small
 * model). Findings sit BETWEEN the two on purpose — the user's own words must
 * stay the final thing the model reads, since they are the only part it can
 * have typed seconds earlier with a specific intent. Each present part is
 * separated by a blank line and the whole block is preceded by a blank line so
 * it reads as a distinct section after the guardrails.
 */
export function buildSteeringSuffix(
  steering?: RewriteSteering,
  units?: readonly string[],
  unitNoun = "Bullet",
): string {
  if (!steering) return "";

  const parts: string[] = [];

  if (steering.pageTarget !== undefined) {
    parts.push(PAGE_BUDGET[steering.pageTarget]);
  }

  if (steering.findings !== undefined && units !== undefined) {
    const block = renderFindings(steering.findings, units, unitNoun);
    if (block !== null) parts.push(block);
  }

  const instructions = steering.userInstructions?.trim();
  if (instructions) {
    parts.push(`The user has these additional instructions: ${instructions}`);
  }

  if (parts.length === 0) return "";

  return `\n\n${parts.join("\n\n")}`;
}

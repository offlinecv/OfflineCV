// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Chain-of-sections whole-resume rewrite orchestrator (issue #67).
 *
 * Phase 1 (#63) rewrites one role's bullets in isolation. The orchestrator
 * here sequences calls across the whole résumé: summary first, then each
 * experience role in display order, threading a rolling soft-constraint
 * brief (used action verbs + a one-line glance back at the previous
 * section) into each subsequent call's user prompt.
 *
 * What the orchestrator owns (and nothing else):
 *   - The for-loop and the per-step `onProgress` emission.
 *   - The rolling context construction (used-verb accumulator + a
 *     prior-section preview line, both capped to keep the prompt small).
 *   - Resume-level telemetry: `webllm_resume_rewrite_started`,
 *     `_section_completed` (per step), `_completed`, and the per-model
 *     one-shot `webllm_first_resume_rewrite`.
 *
 * What the orchestrator does NOT own:
 *   - Engine management — `loadEngine` is the caller's problem.
 *   - Inference serialization — the inner `rewrite*WithLlm` primitives
 *     already bracket their model calls with `acquireInference` /
 *     `releaseInference`, so a cross-model picker switch defers `.unload()`
 *     until our step completes.
 *   - The cross-instance "one rewrite at a time" UI lock — that's
 *     `useSectionRewriteLock`'s job, held by the hook layer.
 *   - Section-level telemetry — the section primitive already fires its own
 *     `webllm_section_rewrite_*` events. The resume-level events are
 *     ADDITIVE so a single whole-résumé run shows up in both funnels.
 */

import {
  trackWebllmFirstResumeRewrite,
  trackWebllmResumeRewriteCompleted,
  trackWebllmResumeRewriteSectionCompleted,
  trackWebllmResumeRewriteStarted,
} from "../analytics.ts";
import {
  rewriteSectionWithLlm,
  type SectionRewriteResult,
} from "./rewrite-section.ts";
import {
  rewriteSummaryWithLlm,
  type SummaryRewriteResult,
} from "./rewrite-summary.ts";
import type { RewriteSteering } from "./steering.ts";
import type { WebLlmEngine } from "./types.ts";
import { accumulatePhrases, buildPhraseBrief } from "./phrase-tracking.ts";
import { accumulateVerbs, buildVerbBrief } from "./verb-tracking.ts";

/**
 * One section of the résumé as the orchestrator sees it. `kind` discriminates
 * which primitive to invoke; `id` and `label` are UI-stable identifiers for
 * the caller's step indicator + per-section panels (the orchestrator never
 * inspects them).
 */
export type SectionInput =
  | { kind: "summary"; id: string; label: string; text: string }
  | {
      kind: "experience";
      id: string;
      label: string;
      bullets: readonly string[];
    };

export type SectionOutcome =
  | {
      kind: "summary";
      input: Extract<SectionInput, { kind: "summary" }>;
      data: SummaryRewriteResult;
    }
  | {
      kind: "experience";
      input: Extract<SectionInput, { kind: "experience" }>;
      data: SectionRewriteResult;
    };

export interface ResumeRewriteProgress {
  /**
   * 0-based index of the section currently in flight. After the orchestrator
   * completes, this equals `totalSections` and `completed.length` equals
   * `totalSections` — the UI uses that signal to swap into the proposed
   * state.
   */
  currentIndex: number;
  totalSections: number;
  /**
   * Label of the section currently being rewritten (e.g. "Summary",
   * "Senior Engineer — Acme"). `null` on the final completion event
   * (`currentIndex === totalSections`) where no section is in flight.
   * The UI uses this to render "Rewriting 2 of 4: Senior Engineer — Acme"
   * instead of the generic "Section 2".
   */
  currentLabel: string | null;
  /**
   * Outcomes accumulated so far. Length === `currentIndex` while a section is
   * in flight (the outcome for index N lands here just before
   * `onProgress({ currentIndex: N + 1, … })` fires).
   */
  completed: readonly SectionOutcome[];
}

export interface ResumeRewriteResult {
  sections: readonly SectionOutcome[];
  /**
   * True iff every section's `numbersPreserved` was true. The UI aggregates
   * each section's `dropped` / `added` tokens for the warning copy, so the
   * orchestrator only needs the boolean.
   */
  allNumbersPreserved: boolean;
}

/** Mirror of `firstSectionRewriteFiredFor` in rewrite-section.ts. */
const firstResumeRewriteFiredFor = new Set<string>();

/**
 * Cap on the prior-section preview folded into the rolling context. The
 * brief is meant to keep the model oriented, not to dump the whole previous
 * section back at it — small instruct models lose the actual instruction
 * when the prompt balloons. A single line truncated to ~140 chars is
 * empirically enough to anchor narrative continuity without eating the
 * model's instruction-following budget.
 */
const PRIOR_PREVIEW_CHAR_CAP = 140;

/**
 * Build the rolling context brief threaded into the NEXT section's SYSTEM
 * prompt as a reference-only block. Three parts, per #67:
 *
 *   1. **Verb constraint** — accumulated leading verbs from every previously
 *      rewritten bullet/summary, formatted as a "Choose different verbs"
 *      sentence.
 *   2. **Phrase constraint** — accumulated 2-word post-verb content
 *      phrases ("distributed systems", "internal admin tool"), formatted
 *      as an "Avoid repeating these exact phrases" sentence. The "and
 *      strong phrases" half of the #67 dedup spec.
 *   3. **Prior preview** — a one-line glance back at the most recent
 *      section's first rewritten unit (truncated to ~140 chars). The
 *      "already-rewritten sections as a brief" half of the #67 rolling-
 *      context spec.
 *
 * All three live in the system message via `buildSectionSystemPrompt`,
 * NOT the user message — small instruct models otherwise read the prior
 * preview line as a bullet to echo into their output (the bug the
 * first-pass implementation tripped over).
 *
 * Returns `undefined` for the first section in the chain (no context yet).
 */
export function buildResumeContext(
  completed: readonly SectionOutcome[],
  usedVerbs: ReadonlySet<string>,
  usedPhrases: ReadonlySet<string>,
): string | undefined {
  const parts: string[] = [];

  const verbBrief = buildVerbBrief(usedVerbs);
  if (verbBrief !== null) parts.push(verbBrief);

  const phraseBrief = buildPhraseBrief(usedPhrases);
  if (phraseBrief !== null) parts.push(phraseBrief);

  const prior = completed[completed.length - 1];
  if (prior !== undefined) {
    const preview = previewFromOutcome(prior);
    if (preview !== null) {
      parts.push(`Earlier section's first bullet was: "${preview}"`);
    }
  }

  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function previewFromOutcome(outcome: SectionOutcome): string | null {
  if (outcome.kind === "summary") {
    const text = outcome.data.text;
    if (!text) return null;
    return truncate(text, PRIOR_PREVIEW_CHAR_CAP);
  }
  const first = outcome.data.bullets[0];
  if (!first) return null;
  return truncate(first, PRIOR_PREVIEW_CHAR_CAP);
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * Process every section in `sections` sequentially, threading a rolling
 * context brief from the prior sections into each subsequent call. The
 * orchestrator never runs two model calls in parallel — the chain semantics
 * are the point.
 *
 * `onProgress` is invoked:
 *   - Once at the start of each step BEFORE the model call (so the UI can
 *     show "Rewriting 2 of 5: Senior Engineer at Foo" before the call
 *     blocks).
 *   - Once at the very end with `currentIndex === totalSections` (the UI
 *     uses this to transition into the proposed state with the completed
 *     outcome list).
 *
 * Empty inputs (a "summary" section with an empty `text`, an "experience"
 * section with zero bullets) are silently skipped so the orchestrator
 * stays linear-in-N over what it can actually rewrite. The caller is
 * expected to filter these out upstream, but we double-check defensively
 * because the data path goes through a hand-built section list in the UI.
 */
export async function rewriteResumeWithLlm(
  sections: readonly SectionInput[],
  engine: WebLlmEngine,
  modelId: string,
  onProgress: (progress: ResumeRewriteProgress) => void,
  steering?: RewriteSteering,
): Promise<ResumeRewriteResult> {
  const rewriteable = sections.filter(isNonEmptySection);
  const totalSections = rewriteable.length;

  trackWebllmResumeRewriteStarted({ model: modelId, sectionCount: totalSections });

  const completed: SectionOutcome[] = [];
  const usedVerbs = new Set<string>();
  const usedPhrases = new Set<string>();

  for (let i = 0; i < totalSections; i++) {
    const section = rewriteable[i]!;
    onProgress({
      currentIndex: i,
      totalSections,
      currentLabel: section.label,
      completed: [...completed],
    });

    const context = buildResumeContext(completed, usedVerbs, usedPhrases);
    const outcome = await runOne(section, engine, modelId, context, steering);
    completed.push(outcome);
    accumulateOutcomeSignals(outcome, usedVerbs, usedPhrases);

    trackWebllmResumeRewriteSectionCompleted({
      model: modelId,
      sectionIndex: i,
      sectionKind: outcome.kind,
      inputUnitCount: inputUnitCountOf(section),
      outputUnitCount: outputUnitCountOf(outcome),
      numbersPreserved: outcome.data.numbersPreserved,
    });
  }

  const allNumbersPreserved = completed.every((o) => o.data.numbersPreserved);

  trackWebllmResumeRewriteCompleted({
    model: modelId,
    sectionCount: totalSections,
    allNumbersPreserved,
  });

  // Per-model one-shot — only counts a run that produced at least one
  // non-empty section outcome, so a model that returned nothing across
  // every section doesn't pollute the conversion funnel.
  if (
    !firstResumeRewriteFiredFor.has(modelId) &&
    completed.some((o) => outputUnitCountOf(o) > 0)
  ) {
    firstResumeRewriteFiredFor.add(modelId);
    trackWebllmFirstResumeRewrite({ model: modelId });
  }

  onProgress({
    currentIndex: totalSections,
    totalSections,
    currentLabel: null,
    completed: [...completed],
  });

  return { sections: completed, allNumbersPreserved };
}

function isNonEmptySection(section: SectionInput): boolean {
  if (section.kind === "summary") return section.text.trim().length > 0;
  return section.bullets.some((b) => b.trim().length > 0);
}

async function runOne(
  section: SectionInput,
  engine: WebLlmEngine,
  modelId: string,
  context: string | undefined,
  steering: RewriteSteering | undefined,
): Promise<SectionOutcome> {
  // `context` and `steering` are independently optional; build the options
  // object with only the keys that are set so a no-steering / first-section
  // call stays bit-identical to the pre-#210 / pre-context path.
  const options =
    context !== undefined || steering !== undefined
      ? {
          ...(context !== undefined ? { context } : {}),
          ...(steering !== undefined ? { steering } : {}),
        }
      : undefined;
  if (section.kind === "summary") {
    const data = await rewriteSummaryWithLlm(
      section.text,
      engine,
      modelId,
      options,
    );
    return { kind: "summary", input: section, data };
  }
  const data = await rewriteSectionWithLlm(
    section.bullets,
    engine,
    modelId,
    options,
  );
  return { kind: "experience", input: section, data };
}

/**
 * Fold an outcome's rewritten units into both the verb and phrase running
 * sets in one pass. The accumulators (`accumulateVerbs` / `accumulatePhrases`)
 * already handle the "delete-then-add for recency" semantics; we just have
 * to hand them the same string-array shape for both kinds. The summary
 * outcome is wrapped in a single-element array so the orchestrator doesn't
 * need a separate code path for the paragraph case.
 */
function accumulateOutcomeSignals(
  outcome: SectionOutcome,
  verbs: Set<string>,
  phrases: Set<string>,
): void {
  const lines: readonly string[] =
    outcome.kind === "summary" ? [outcome.data.text] : outcome.data.bullets;
  accumulateVerbs(lines, verbs);
  accumulatePhrases(lines, phrases);
}

function inputUnitCountOf(section: SectionInput): number {
  return section.kind === "summary" ? 1 : section.bullets.length;
}

function outputUnitCountOf(outcome: SectionOutcome): number {
  if (outcome.kind === "summary") return outcome.data.text.length > 0 ? 1 : 0;
  return outcome.data.bullets.length;
}

/** Test-only: drop the per-model one-shot telemetry flags between tests. */
export function _resetResumeRewriteFlagsForTesting(): void {
  firstResumeRewriteFiredFor.clear();
}

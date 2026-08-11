// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * rewrite-findings.ts — turn the app's OWN analysis of a résumé into the
 * per-line notes the rewriter is steered by (#608).
 *
 * The defect this closes: offlinecv computes three independent streams of
 * feedback about a résumé (LLM critique findings, term-quality "missing
 * skills", JD-match coverage gaps) and `rewriteResumeWithLlm` received NONE of
 * them. A user could read a critique saying "this bullet has no
 * quantification", click **Rewrite full résumé**, and get a rewrite that
 * addressed neither — because the rewriter was never told. Three features that
 * did not know about each other.
 *
 * ── Why only the bullet critique ships here ──
 * Of the three streams, `ResumeCritique.bulletFindings` is the one that joins
 * cleanly: it is computed PER BULLET, keyed on the bullet's own text, and the
 * rewriter processes bullets per section with those same strings in hand. The
 * join is a map lookup.
 *
 * The other two are résumé-GLOBAL and deliberately deferred (#608 "which
 * streams ship first"):
 *   - term-quality `missing` skills name capabilities absent from the whole
 *     document, so there is no line to attach them to and no section that
 *     obviously owns them. Injected per-section they would either repeat on
 *     every section (the prompt-balloon failure mode) or land arbitrarily.
 *   - JD coverage gaps have the same shape, and the JD-tailor path (#576)
 *     already routes its JD steering through `userInstructions`.
 * Both want a résumé-level injection point, which is a different design than
 * this one. Adding them here would mean pretending they are per-line.
 *
 * ── What is deliberately dropped ──
 * `issue: "ok"` findings carry no instruction — a note saying "this bullet is
 * fine" spends prompt budget to say nothing, and a small instruct model reading
 * a list where most entries are "ok" learns that the list is ignorable. Only
 * actionable findings survive, so the block is short and every line in it asks
 * for something.
 *
 * `missingSections` and `summaryFeedback` are handled separately: the former
 * names sections the rewriter cannot create (it rewrites what it is given), and
 * the latter is attached to the summary unit rather than a bullet.
 *
 * Pure: no React, no model, no I/O. Returns `undefined` rather than an empty
 * map when nothing is actionable, so the caller's `findings === undefined`
 * check is the single "this contributes nothing" signal and the generated
 * prompt stays byte-identical to the pre-#608 output.
 */

import type { BulletFinding, ResumeCritique } from "./critique-resume.ts";
import { findingsKey } from "./steering.ts";

/**
 * Human-readable note per issue category. These are the words that reach the
 * model, so they are phrased as INSTRUCTIONS ("add a concrete metric"), not as
 * diagnoses ("no quantification") — a small instruct model acts on the former
 * and merely acknowledges the latter.
 *
 * `ok` maps to null: it is filtered out entirely (see the module docblock).
 */
const ISSUE_NOTE: Record<BulletFinding["issue"], string | null> = {
  no_quantification: "add a concrete metric or outcome",
  weak_verb: "lead with a stronger action verb",
  vague: "make this specific — name the system, scope, or result",
  ok: null,
};

/**
 * The note text for one finding: the category instruction, plus the critique's
 * own `suggestion` when it produced one.
 *
 * The suggestion is included because it is already a rewrite hint — it is the
 * single most useful thing the critique produced — but it is labelled
 * `suggested:` rather than pasted as if it were the required output, so the
 * model treats it as a direction and not as text to copy verbatim. The
 * anti-fabrication guardrail that keeps a suggested *number* out of the résumé
 * lives with the block itself (`FINDINGS_PREAMBLE` in `steering.ts`).
 */
function noteFor(finding: BulletFinding): string | null {
  const base = ISSUE_NOTE[finding.issue];
  if (base === null) return null;
  const suggestion = finding.suggestion?.trim();
  return suggestion ? `${base} (suggested: ${suggestion})` : base;
}

/**
 * Build the {@link RewriteSteering.findings} map from a critique.
 *
 * Keyed by {@link findingsKey}, so a bullet the critique echoed back with
 * different whitespace or a re-added leading marker still joins to the
 * rewriter's copy of the same line.
 *
 * Two findings can normalise to the SAME key — a résumé that repeats a bullet
 * verbatim across two roles is common, and the critique emits one finding per
 * occurrence. Their notes are concatenated onto the one key rather than
 * last-write-wins, because both occurrences are rewritten and dropping one
 * silently loses a finding the user was shown. Duplicate note text is collapsed
 * so the identical finding twice reads once.
 *
 * Returns `undefined` when nothing actionable survives, so the caller can pass
 * it straight through to `RewriteSteering.findings` and get the pre-#608 prompt.
 */
export function findingsFromCritique(
  critique: ResumeCritique | undefined,
  summaryText?: string,
): ReadonlyMap<string, readonly string[]> | undefined {
  if (!critique) return undefined;

  const byKey = new Map<string, string[]>();
  const add = (key: string, note: string): void => {
    if (key.length === 0) return;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, [note]);
    else if (!existing.includes(note)) existing.push(note);
  };

  for (const finding of critique.bulletFindings) {
    const note = noteFor(finding);
    if (note === null) continue;
    add(findingsKey(finding.bullet), note);
  }

  // `summaryFeedback` is prose ABOUT the summary paragraph — the critique never
  // echoes the paragraph itself back, so unlike a bullet finding it arrives with
  // no text to key on. The caller supplies that text (the same string the
  // summary section is about to be rewritten from), which keeps the ONE map
  // uniform: every entry is keyed by the unit it describes, so the summary path
  // needs no reserved key and no parallel channel. A reserved sentinel was the
  // first design and does not survive `findingsKey`, which would normalise it
  // into the same space as a bullet literally reading "Summary". Omit
  // `summaryText` and the note is dropped rather than filed unreachably.
  const summaryNote = critique.summaryFeedback?.trim();
  if (summaryNote && summaryText !== undefined) {
    add(findingsKey(summaryText), summaryNote);
  }

  return byKey.size > 0 ? byKey : undefined;
}

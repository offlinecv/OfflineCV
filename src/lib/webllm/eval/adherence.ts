// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Steering adherence — did the model actually DO what the user's instruction
 * said? (#608, half 2.)
 *
 * The user report behind #608 is "the rewrite ignores my instructions".
 * `RewriteSteering.userInstructions` demonstrably reaches the system prompt via
 * `buildSteeringSuffix`, so the report is either a real prompt-adherence defect
 * or per-model variance — and nothing in the repo could tell those apart,
 * because nothing measured adherence. #608 is explicit that the measurement
 * must come BEFORE any prompt change ("Do not guess between these"), which is
 * what this file makes possible.
 *
 * ── Why the checks are deterministic and not a judge model ──
 * The rubric's whole premise (`rubric.ts`, and the eval README's "picked from
 * measurement rather than vibes") is model-free scoring: a judge model would
 * make the adherence number itself a function of the thing under test, and a
 * flaky judge produces a flaky verdict that cannot settle an argument. So an
 * adherence fixture may only carry an instruction whose compliance is
 * checkable by string inspection — "do not use the word X", "keep every bullet
 * under N words", "start every bullet with a different verb". That rules out
 * the instructions users actually type ("make it punchier"), and that is the
 * deliberate trade: an instruction we can verify is worth more than one we can
 * only feel.
 *
 * ── What a failure here does and does not mean ──
 * A low adherence rate says the model did not follow a MECHANICAL instruction.
 * It does not by itself distinguish #608's three candidate causes (per-section
 * repetition of a résumé-global instruction, prompt-budget crowding, or model
 * variance) — the run has to be read across the model and variant axes for
 * that. The criterion is the instrument, not the conclusion.
 *
 * Pure: no model, no I/O, no engine. Unit-tested against deliberately
 * non-compliant output so the scorer is proven to bite before any verdict is
 * trusted (#608 AC).
 */

import { startsWithActionVerb } from "./verbs.ts";
import type { AdherenceCheck } from "./types.ts";

/**
 * Count words the way a human reading "keep every bullet under 15 words"
 * would: whitespace-delimited tokens that contain at least one letter or
 * digit, so a spaced em-dash or a stray bullet glyph is not a word.
 *
 * Deliberately the same rule as `score.ts::countWords` (#627) rather than a
 * second answer to the same question — a bullet the product scores as 14 words
 * must not be 15 words here, or the eval and the app disagree about a fixture
 * that is right on the boundary. It is re-stated rather than imported because
 * `eval/` is a self-contained scoring leg (`verbs.ts` re-states the verb set
 * for the same reason), and a cross-import would drag the scorer's module graph
 * into the browser eval bundle.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** The lowercased leading token of a bullet, stripped to letters — the same
 *  normalization `startsWithActionVerb` applies, so "Led," and "led" are one
 *  verb for the distinctness check. Empty string when there is none. */
function leadingVerb(bullet: string): string {
  return (
    bullet
      .split(/\s/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, "") ?? ""
  );
}

/**
 * Score one adherence check against a model's output bullets.
 *
 * Empty output is NOT vacuously compliant — the same rule the rest of the
 * rubric follows (`oneLinePerBullet`, `actionVerbLead`). A model that returned
 * nothing has not demonstrated it followed the instruction; scoring it as a
 * pass would let the worst possible response inflate the adherence rate, which
 * is precisely backwards for a criterion whose job is to detect being ignored.
 */
export function scoreAdherence(
  check: AdherenceCheck,
  outputBullets: readonly string[],
): boolean {
  if (outputBullets.length === 0) return false;

  switch (check.kind) {
    case "forbidden-word": {
      // Case-insensitive, and anchored on word boundaries so the instruction
      // is about the WORD: "spearheaded" must fail, while "spearheadedness" —
      // a different word that merely contains those letters — must not.
      //
      // The word is escaped (it comes from a committed fixture, but an
      // unescaped metacharacter would silently change what is being checked),
      // and each boundary is applied only where `\b` MEANS anything. `\b` sits
      // between a word and a non-word character, so for a term ending in
      // punctuation — "c++" — a trailing `\b` can never match: `+` and the
      // following space are both non-word, so there is no boundary there and
      // the check would silently never fire. A criterion that cannot fail is
      // the exact failure this scorer exists to rule out, so the boundary is
      // conditioned on the term's own edges instead of assumed.
      const escaped = check.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const lead = /^\w/.test(check.word) ? "\\b" : "";
      const trail = /\w$/.test(check.word) ? "\\b" : "";
      const re = new RegExp(`${lead}${escaped}${trail}`, "i");
      return !outputBullets.some((b) => re.test(b));
    }
    case "max-words":
      return outputBullets.every((b) => countWords(b) <= check.limit);
    case "distinct-verbs": {
      const verbs = outputBullets.map(leadingVerb);
      // A bullet with no leading verb at all cannot satisfy "start every bullet
      // with a DIFFERENT verb" — it did not start with one.
      if (verbs.some((v) => v.length === 0)) return false;
      // Guard against the degenerate pass where nothing leads with a verb but
      // the tokens happen to differ; the instruction presupposes verb-leading.
      if (!outputBullets.every((b) => startsWithActionVerb(b))) return false;
      return new Set(verbs).size === verbs.length;
    }
  }
}

/** Human-readable description of a check, for the committed report's prose. */
export function describeCheck(check: AdherenceCheck): string {
  switch (check.kind) {
    case "forbidden-word":
      return `must not use the word "${check.word}"`;
    case "max-words":
      return `every bullet ≤ ${check.limit} words`;
    case "distinct-verbs":
      return "every bullet leads with a different action verb";
  }
}

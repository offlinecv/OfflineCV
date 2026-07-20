// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { checkNumbersPreserved } from "../preserve-numbers.ts";
import type {
  FixtureKind,
  PerBulletDiagnostic,
  RawRewriteOutput,
  RubricResult,
} from "./types.ts";
import { startsWithActionVerb } from "./verbs.ts";

/**
 * Deterministic rubric: takes the input bullets + a model's raw rewrite
 * output and emits a per-criterion pass/fail record. No judge model.
 *
 * The six criteria are the issue #65 AC list:
 *
 *   1. numbersPreserved   — multiset of numeric tokens unchanged
 *   2. oneLinePerBullet   — no embedded `\n` after the runner's split
 *   3. actionVerbLead     — first token of each bullet in the curated set
 *   4. lengthSanity       — each bullet in a sane char band
 *   5. noPreambleLeak     — output doesn't echo prompt scaffolding
 *   6. dedupEffective     — for `redundant` fixtures only: output < input
 *
 * Each criterion is computed independently — one failing does NOT
 * short-circuit the others, because the report's per-criterion pass rate
 * is more useful than a single composite verdict.
 */

/** Sanity band for a single bullet. Below MIN reads as a truncated
 * fragment; above MAX reads as a run-on or multi-bullet collapse. The
 * band intentionally covers strong real-world bullets (most of which
 * land in the 60–180 range). */
const BULLET_MIN_CHARS = 25;
const BULLET_MAX_CHARS = 260;

/**
 * Phrases that indicate the model echoed prompt scaffolding into the
 * output. Cleaned by `cleanRewriteLine` already, but the rubric also
 * scans the RAW pre-split output to catch leakage that survived (e.g.
 * spread across multiple lines, or with non-standard capitalization).
 *
 * The check is substring (case-insensitive) against the raw response
 * with the bullet lines stripped, so a legitimate bullet that contains
 * "the rules of engagement" doesn't trip the criterion.
 */
const PREAMBLE_LEAK_PHRASES = [
  "rewritten bullets:",
  "original bullets:",
  "here are the rewritten",
  "here is the rewritten",
  "rules:",
  "system:",
  "as an ai",
  "as a language model",
];

/**
 * Returns the empty rubric used for an error row (RewriteFn threw, or
 * returned an unparseable response). All criteria fail so the row
 * surfaces in the report instead of being silently scored as a pass.
 */
export function emptyRubricForError(): RubricResult {
  return {
    numbersPreserved: false,
    oneLinePerBullet: false,
    actionVerbLead: false,
    lengthSanity: false,
    noPreambleLeak: false,
    dedupEffective: null,
    judgeCoherence: null,
    perBullet: [],
    droppedNumbers: [],
    addedNumbers: [],
  };
}

export interface ScoreRubricInput {
  input: readonly string[];
  output: RawRewriteOutput;
  fixtureKind: FixtureKind;
}

export function scoreRubric({
  input,
  output,
  fixtureKind,
}: ScoreRubricInput): RubricResult {
  const outputBullets = output.bullets;

  // ── (1) Numbers preserved ─────────────────────────────────────────────
  const preservation = checkNumbersPreserved(input, outputBullets);

  // ── (2) One line per bullet ───────────────────────────────────────────
  // The runner already split on `\n`, so an embedded `\n` here would
  // only appear if the post-process kept a literal `\n` token (e.g. a
  // Windows `\r` survived). Explicit check on each bullet keeps the
  // criterion honest if the splitting strategy changes.
  //
  // Empty output is NOT vacuously a pass: the model produced no bullets
  // at all, so the "every bullet is one line" claim has nothing to back
  // it. Require at least one bullet for the criterion to be true.
  const oneLinePerBullet =
    outputBullets.length > 0 && outputBullets.every((b) => !/[\r\n]/.test(b));

  // ── (3) Action-verb lead ──────────────────────────────────────────────
  const verbResults = outputBullets.map((b) => startsWithActionVerb(b));
  const actionVerbLead =
    outputBullets.length > 0 && verbResults.every((v) => v);

  // ── (4) Length sanity ─────────────────────────────────────────────────
  const lengthResults = outputBullets.map(
    (b) => b.length >= BULLET_MIN_CHARS && b.length <= BULLET_MAX_CHARS,
  );
  const lengthSanity =
    outputBullets.length > 0 && lengthResults.every((v) => v);

  // ── (5) No preamble leakage ───────────────────────────────────────────
  // Two failure modes; we have to catch both.
  //
  // (a) Preamble survived in the raw response between/around bullets.
  //     Scan the RAW response with the bullet text stripped so a phrase
  //     like "rules:" embedded in a legitimate bullet doesn't trip.
  //
  // (b) Preamble survived AS a bullet — e.g. Llama emitting
  //     "Here are the rewritten bullets:" as its own line, which the
  //     line-splitter then treats as outputBullets[0]. Without an
  //     explicit per-bullet check, the raw-minus-bullets scan in (a)
  //     would erase the leaked preamble from rawMinusBullets and report
  //     a false-positive pass.
  //
  // The per-bullet check uses `startsWith`, not `includes`: a preamble
  // is always at the START of a line by shape (it's what the model
  // emits BEFORE the real bullets). `includes` would false-positive on
  // legitimate bullets like "Worked as an AI engineer on …" (which
  // contains the "as an ai" phrase mid-bullet).
  //
  // Fix for #151. Both checks must pass for `noPreambleLeak` to be true.
  let rawMinusBullets = output.raw.toLowerCase();
  for (const b of outputBullets) {
    rawMinusBullets = rawMinusBullets.replace(b.toLowerCase(), "");
  }
  const anyBulletIsPreamble = outputBullets.some((b) => {
    const lower = b.trim().toLowerCase();
    return PREAMBLE_LEAK_PHRASES.some((p) => lower.startsWith(p));
  });
  const noPreambleLeak =
    !anyBulletIsPreamble &&
    !PREAMBLE_LEAK_PHRASES.some((p) => rawMinusBullets.includes(p));

  // ── (6) Dedup effectiveness ───────────────────────────────────────────
  // Only meaningful for fixtures that explicitly stage redundancy. For
  // other kinds, the criterion is `null` (not applicable) — the report
  // displays `—` and the aggregate ignores them.
  //
  // The non-empty guard matters: a model returning zero bullets would
  // trivially satisfy `output < input`, but that's a model failure, not
  // a dedup win. Require at least one bullet.
  const dedupEffective: boolean | null =
    fixtureKind === "redundant"
      ? outputBullets.length > 0 && outputBullets.length < input.length
      : null;

  const perBullet: PerBulletDiagnostic[] = outputBullets.map((b, i) => ({
    index: i,
    text: b,
    startsWithActionVerb: verbResults[i] ?? false,
    lengthOk: lengthResults[i] ?? false,
    oneLine: !/[\r\n]/.test(b),
  }));

  return {
    numbersPreserved: preservation.ok,
    oneLinePerBullet,
    actionVerbLead,
    lengthSanity,
    noPreambleLeak,
    dedupEffective,
    judgeCoherence: null,
    perBullet,
    droppedNumbers: preservation.dropped,
    addedNumbers: preservation.added,
  };
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { ACTION_VERBS as SCORER_ACTION_VERBS } from "../../score/score.ts";

/**
 * Action-verb list used by the eval rubric's `actionVerbLead` criterion.
 *
 * Built as the scorer's curated past-tense set + a small eval-only
 * extension. The scorer set lives in `src/lib/score/score.ts` so when a
 * verb is added there it lights up here automatically — single source of
 * truth, no drift.
 *
 * The extension covers two cases the scorer set doesn't:
 *
 *   1. Tense breadth — small instruct models occasionally emit
 *      present-progressive forms ("Building / Driving / Owning") in
 *      rewrite output. The scorer never sees those because users write
 *      résumés in past tense.
 *   2. Cross-discipline verbs — "analyzed / authored / wrote / programmed"
 *      are normal for IC and writing-heavy roles. The scorer set leans
 *      eng/PM and would over-penalize a research-coded résumé.
 *
 * Weak generic verbs ("worked", "helped", "responsible", "assisted",
 * "participated") are deliberately absent — a bullet leading with one of
 * those SHOULD fail the criterion. That's the whole point.
 */

const EVAL_ONLY_EXTENSIONS: readonly string[] = [
  // Eng / data IC verbs the scorer set doesn't cover.
  "analyzed", "authored", "configured", "debugged", "deployed",
  "engineered", "investigated", "prototyped", "rewrote", "shipped",
  "tested", "validated", "wrote",
  // Cross-discipline (research / ops / comms) IC verbs.
  "completed", "conducted", "drafted", "identified", "owned",
  "performed", "planned", "presented", "produced", "published",
  "secured", "tracked",
  // Present-progressive forms small models sometimes emit.
  "building", "driving", "leading", "managing", "designing",
  "shipping", "scaling", "owning",
];

export const ACTION_VERBS: ReadonlySet<string> = new Set([
  ...SCORER_ACTION_VERBS,
  ...EVAL_ONLY_EXTENSIONS,
]);

/**
 * First-token check that mirrors `score.ts::startsWithActionVerb`:
 * lowercase the first whitespace-delimited token, strip everything that
 * isn't a-z, and look up in the union set. The strip handles trailing
 * punctuation (`Led,`, `Shipped:`) without expanding the set with
 * decorated variants.
 *
 * Returns `false` for an empty bullet — empty bullets should never make
 * it past the rubric's line-splitting cleanup, but the guard keeps the
 * behavior defined.
 */
export function startsWithActionVerb(bullet: string): boolean {
  const firstWord = bullet
    .split(/\s/)[0]
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!firstWord) return false;
  return ACTION_VERBS.has(firstWord);
}

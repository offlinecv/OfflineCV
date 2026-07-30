// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { ACTION_VERBS as SCORER_ACTION_VERBS } from "../../lexicon/action-verbs.ts";

/**
 * Action-verb list used by the eval rubric's `actionVerbLead` criterion.
 *
 * Built as the scorer's curated past-tense set + a small eval-only
 * extension. The base set lives in `src/lib/lexicon/action-verbs.ts` so when
 * a verb is added there it lights up here automatically — single source of
 * truth, no drift.
 *
 * The extension covers two cases the scorer set doesn't:
 *
 *   1. Tense breadth — small instruct models occasionally emit
 *      present-progressive forms ("Building / Driving / Owning") in
 *      rewrite output. The scorer never sees those because users write
 *      résumés in past tense.
 *   2. Cross-discipline verbs — "configured / debugged / drafted / wrote"
 *      are normal for IC and writing-heavy roles. The scorer set leans
 *      eng/PM and would over-penalize a research-coded résumé.
 *
 * (#622) Past-tense, general-register verbs that used to live only here
 * ("shipped", "owned", "secured", "deployed", "engineered", "rewrote",
 * "authored", "analyzed", "conducted", "identified", "presented",
 * "produced", "published", "planned") were promoted into the scorer's base
 * set — they belonged there, not in an eval-only carve-out. A test asserts
 * this list stays disjoint from `ACTION_VERBS` so the two can't silently
 * re-diverge.
 *
 * Weak generic verbs ("worked", "helped", "responsible", "assisted",
 * "participated") are deliberately absent — a bullet leading with one of
 * those SHOULD fail the criterion. That's the whole point.
 */

// Exported so `verbs.test.ts` can assert this set stays disjoint from the
// shared `ACTION_VERBS` (#622) — everything else in this module stays
// module-internal.
export const EVAL_ONLY_EXTENSIONS: readonly string[] = [
  // Eng / data IC verbs the scorer set doesn't cover.
  "configured", "debugged", "investigated", "prototyped", "tested",
  "validated", "wrote",
  // Cross-discipline (research / ops / comms) IC verbs.
  "completed", "drafted", "performed", "tracked",
  // Present-progressive forms small models sometimes emit.
  "building", "driving", "leading", "managing", "designing",
  "shipping", "scaling", "owning",
];

// Module-internal: only `startsWithActionVerb` is consumed by the rubric.
// Not exported — keeping it local avoids a dead public export and a name
// collision with the shared `ACTION_VERBS` (both flagged by fallow).
const ACTION_VERBS: ReadonlySet<string> = new Set([
  ...SCORER_ACTION_VERBS,
  ...EVAL_ONLY_EXTENSIONS,
]);

/**
 * First-token check that mirrors the shared `startsWithActionVerb`:
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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The journey completion ledger (issue #826) — "you HAVE BEEN here", which is a
 * different question from the one `journey.ts`'s `availability` answers ("you
 * CAN go here").
 *
 * The rail shipped in #812 with only the second, and drew a ✓ from it: the
 * instant a résumé parsed, `Download` and `Match jobs` both claimed completion
 * over a PDF that had never been exported and a job board that had never been
 * searched. The screen-reader sentence was right ("Ready."); the glyph was the
 * lie, because ✓ means done in every progress rail ever shipped. This module is
 * the ledger the rail did not have, so the glyph can state a fact.
 *
 * Four milestones, and `add` is deliberately not one of them: a résumé being on
 * the page IS its completion, derivable with no ledger at all (see
 * `deriveJourney`).
 *
 * **`localStorage`, not the IndexedDB résumé record.** Putting it in the record
 * would drag `record-contract.ts`, `backup.ts` and the sync schema along for
 * state that is disposable UI progress rather than the user's work. Losing this
 * file's contents costs a checkmark, not a résumé — which is also why every
 * read and every write here is wrapped: private mode and a full quota degrade
 * to "no ✓ marks", never to a throw. Key follows the repo's `ocv_*` convention.
 *
 * **Keyed per résumé, and bounded.** A ledger keyed on résumé identity grows
 * once per résumé forever otherwise, so the map is capped and the least
 * recently WRITTEN entry is evicted first. The key itself is minted by the
 * surface (`App`), not here: it is `fingerprintParse` of the PRISTINE parse —
 * before the edit layer and before LLM recovery — because the obvious key,
 * the edit-folded fields `fingerprintParse` is used over everywhere else,
 * changes on every keystroke and would drop the mark the moment the user typed
 * one character.
 *
 * Stored as an ARRAY of entries rather than a `Record<string, …>` object,
 * because eviction depends on order and a plain object does not keep the one we
 * need: an all-digit key (`fingerprintParse` returns 8 hex chars, so
 * `"12345678"` is a legal output) is an array-index-like property name, which
 * JS hoists ahead of the string keys in ascending numeric order — the eviction
 * would silently drop whichever entry happened to hash to digits.
 *
 * Zero-dep and React-free, with the DECISION factored out from the storage read
 * — `parseLedger` / `completionOf` / `withMilestone` are pure and exported, the
 * way `journey.ts`'s own derivation is, so every branch is testable on plain
 * values. `hooks/useJourneyProgress.ts` is the React wrapper.
 */

import type { JourneyCompletion, JourneyStageId } from "./journey.ts";

/**
 * The stages a user can be recorded as having COMPLETED.
 *
 * Declared as an `Extract` of {@link JourneyStageId} rather than a fresh union
 * so the subset relation is checked by the compiler: a stage renamed in
 * `journey.ts` fails to build here instead of silently becoming a milestone no
 * rail entry can ever read back.
 */
export type JourneyMilestone = Extract<
  JourneyStageId,
  "fix" | "download" | "match" | "tailor"
>;

const MILESTONES: readonly JourneyMilestone[] = [
  "fix",
  "download",
  "match",
  "tailor",
];

/** localStorage key for the completion ledger. */
export const JOURNEY_PROGRESS_KEY = "ocv_journey_progress";

/** How many résumés the ledger remembers before evicting the oldest write. */
export const JOURNEY_PROGRESS_MAX_RESUMES = 20;

/** One résumé's completions. Oldest write first — see {@link withMilestone}. */
export interface JourneyProgressEntry {
  /** The résumé key the surface minted — see the module docblock. */
  key: string;
  /** Milestones completed for it, in the order they happened. */
  done: JourneyMilestone[];
}

function isMilestone(value: unknown): value is JourneyMilestone {
  return MILESTONES.includes(value as JourneyMilestone);
}

/**
 * Parse the stored ledger, dropping anything that is not a well-formed entry.
 *
 * Tolerant rather than strict: this is disposable progress state, so a record
 * half-written by an older build costs the checkmarks it carried and nothing
 * else. Returns `[]` for absent, malformed or unreadable input.
 */
export function parseLedger(raw: string | null): JourneyProgressEntry[] {
  if (raw === null || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: JourneyProgressEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { key, done } = item as Partial<JourneyProgressEntry>;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!Array.isArray(done)) continue;
    entries.push({ key, done: done.filter(isMilestone) });
  }
  return entries;
}

/** What one résumé has completed, as the record `deriveJourney` consumes. */
export function completionOf(
  ledger: readonly JourneyProgressEntry[],
  key: string | null,
): JourneyCompletion {
  if (key === null) return {};
  const entry = ledger.find((e) => e.key === key);
  if (entry === undefined) return {};
  const completion: Partial<Record<JourneyStageId, boolean>> = {};
  for (const milestone of entry.done) completion[milestone] = true;
  return completion;
}

/**
 * Record a milestone, returning the new ledger — or `null` when it was already
 * recorded and nothing needs writing.
 *
 * The touched entry moves to the END, so "oldest write" is a position rather
 * than a timestamp this would otherwise have to store and keep honest. Eviction
 * is from the front, once, because exactly one entry can be added per call.
 */
export function withMilestone(
  ledger: readonly JourneyProgressEntry[],
  key: string,
  milestone: JourneyMilestone,
): JourneyProgressEntry[] | null {
  const existing = ledger.find((e) => e.key === key);
  if (existing?.done.includes(milestone)) return null;
  const done = existing ? [...existing.done, milestone] : [milestone];
  const next = ledger.filter((e) => e.key !== key);
  next.push({ key, done });
  return next.slice(-JOURNEY_PROGRESS_MAX_RESUMES);
}

/**
 * Read one résumé's completions. `{}` for a key with nothing recorded, for a
 * null key (nothing parsed, so nothing to be keyed on), and for storage that
 * cannot be read at all.
 */
export function readJourneyProgress(key: string | null): JourneyCompletion {
  if (key === null) return {};
  let raw: string | null;
  try {
    raw = localStorage.getItem(JOURNEY_PROGRESS_KEY);
  } catch {
    // Private mode / disabled storage — the rail simply shows no ✓ marks.
    return {};
  }
  return completionOf(parseLedger(raw), key);
}

/**
 * Record a milestone for one résumé. Returns whether anything changed, so a
 * caller can skip a re-render for a mark it already had.
 *
 * Never throws: a full quota costs this checkmark and nothing else.
 */
export function markJourneyMilestone(
  key: string,
  milestone: JourneyMilestone,
): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(JOURNEY_PROGRESS_KEY);
  } catch {
    return false;
  }
  const next = withMilestone(parseLedger(raw), key, milestone);
  if (next === null) return false;
  try {
    localStorage.setItem(JOURNEY_PROGRESS_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded — report no change, so the in-memory state stays in step
    // with what a later reload will actually read back.
    return false;
  }
  return true;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-duplicate-dismissals — the "Not the same" half of the duplicate
 * affordance (#746): which pairings of tracked jobs the user has already told
 * us are two different postings, remembered across reloads.
 *
 * ## Why this is not a field on `JobRecord`
 *
 * A dismissal is symmetric — it is about a PAIR, not about either record — so
 * storing it on a record means writing to two of them. That write is the
 * problem, and it is a product problem rather than a plumbing one: `saveJob`
 * stamps `updatedAt` on a user action, the tracker sorts most-recently-updated
 * first, and dismissing a prompt would therefore jump both jobs to the top of
 * the list. A UI dismissal must not reorder the user's library.
 *
 * It also has no business on the capture contract. That contract is normative
 * for third-party producers (`docs/job-capture-contract.md`), and a producer is
 * in no position to assert that the USER decided two of their records are
 * different postings — the same reason `captureJob` strips a `deletedAt`.
 *
 * ## Why localStorage rather than a store of its own
 *
 * An IndexedDB store would cost a schema-version bump and a place in the backup
 * document, for a preference. localStorage is where this app already keeps
 * durable UI decisions (`letter-egress-ack.ts`, `usePersistentFlag.ts`,
 * `useModelSelection.ts`), and the failure direction is the safe one: if the
 * value is lost — private browsing, a cleared origin, a full quota — the user
 * is asked once more about a pairing they already judged. That costs a prompt,
 * never a record, which is the same asymmetry the whole feature is built on.
 * Fail-silent throughout, for the same reason.
 *
 * Entries are never pruned. A dismissal naming a job that has since been
 * deleted (or merged away) is inert — nothing pairs against an id that is no
 * longer in the library — and pruning against the live ids would forget the
 * judgement for a job that a re-capture legitimately revives under the same id
 * (see `capture.ts`). Two ids per entry is a cost worth not managing.
 */

import { jobPairKey } from "./job-duplicates.ts";

const KEY = "offlinecv:jobs:not-duplicates";

/** Every dismissed pairing. An unreadable, absent or malformed value reads as
 *  "nothing dismissed", which re-asks rather than silently suppressing. */
export function readDismissedJobPairs(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw === null || raw === undefined) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

/** Record that the user said two jobs are different postings. Idempotent. */
export function dismissJobPair(a: string, b: string): void {
  const pairs = new Set(readDismissedJobPairs());
  pairs.add(jobPairKey(a, b));
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...pairs]));
  } catch {
    // Fail silent — quota / private mode / security error. The prompt returns
    // next session, which is the safe direction to fail in: the alternative is
    // suppressing a suggestion we did not manage to remember.
  }
}

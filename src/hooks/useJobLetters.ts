// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJobLetters — every letter in the store, grouped by scope (#715, #766).
 *
 * The name predates the scopes. Since #766 a letter is scoped to a job, to a
 * company, or to nothing at all, and this hook reads all three off the one
 * store pass it already made — renaming it would touch every consumer to say
 * the same thing, which is a cost the sibling UI issue can pay if it wants to.
 *
 * The `letters` store has no per-job index — `lettersForJob` itself filters
 * `getAllLetters()` in memory rather than querying one (see its own comment
 * on the `oldVersion < 3` migration). The Saved jobs library needs a cheap
 * "does this job have a letter, and which" answer for every row it renders;
 * calling `lettersForJob` once per row would fire one IndexedDB read per
 * tracked job. Reading the whole store once here and grouping locally is the
 * same trade `lettersForJob` already makes, just amortized across every row
 * instead of one job.
 *
 * Read-only: nothing in this UI writes, edits, or deletes a letter (#715
 * explicitly excludes in-app authoring/editing), so there is no mutation path
 * to wire up here. `refresh` exists for the same reason `useJobTracker` and
 * `useResumeLibrary` expose one — so a future caller can force a re-read
 * without remounting — even though nothing in this build calls it yet.
 */

import { useCallback, useEffect, useState } from "react";
import { getAllLetters } from "../lib/storage/index.ts";
import type { LetterRecord } from "../lib/storage/index.ts";

export interface JobLetters {
  /** True once the initial load has resolved. */
  ready: boolean;
  /** Every letter for a job id, most-recently-updated first — the same order
   *  `lettersForJob` returns. A job id absent from this map has no letters,
   *  which is the signal `JobLetterIndicator` uses to render nothing.
   *
   *  Since #766 this holds JOB letters only. A jobless letter is not a job with
   *  no letters, and folding the two together under a literal `undefined` key
   *  is what the grouping loop below exists to prevent. */
  byJobId: ReadonlyMap<string, LetterRecord[]>;
  /** Company-scoped letters by `companyKey` (#766), same order. Kept beside
   *  `byJobId` rather than inside it: the keyspaces are different — a
   *  `JobRecord.id` and a derived company key — and one map would let a lookup
   *  by job id collide with a company that happened to key alike. */
  byCompanyKey: ReadonlyMap<string, LetterRecord[]>;
  /** Letters scoped to neither a job nor a company (#766), same order. A flat
   *  list because there is no key to group by — that is what makes them
   *  standard. */
  standard: readonly LetterRecord[];
  refresh: () => Promise<void>;
}

/**
 * Split every letter into the three scope tiers of the lattice on
 * `LetterRecord.jobId` (#766), each list most-recently-updated first.
 *
 * At module scope, not inside the hook: it is pure and the interesting part is
 * the `undefined`-key hazard, which is easier to test on a function than
 * through a rendered probe.
 *
 * A letter carrying BOTH keys is a record `validateLetterRecord` refuses, so it
 * can only reach here from a store written before v2 or by a producer that
 * skipped the validator §3 tells it to call. It is read as a job letter — the
 * reading it would have had under v1, which is the only one that cannot hide it
 * from a surface that already existed.
 */
export function groupByScope(letters: readonly LetterRecord[]): {
  byJobId: Map<string, LetterRecord[]>;
  byCompanyKey: Map<string, LetterRecord[]>;
  standard: LetterRecord[];
} {
  const byJobId = new Map<string, LetterRecord[]>();
  const byCompanyKey = new Map<string, LetterRecord[]>();
  const standard: LetterRecord[] = [];

  for (const letter of letters) {
    // The `undefined`-key hazard this loop is written around: `Map.set` on an
    // absent `jobId` would stringify it into a literal `"undefined"` entry that
    // every consumer treats as a job — a bucket no `JobRecord.id` can ever
    // match, holding letters no surface would then find.
    const key = letter.jobId ?? letter.companyKey;
    if (key === undefined) {
      standard.push(letter);
      continue;
    }
    const bucket = letter.jobId !== undefined ? byJobId : byCompanyKey;
    const existing = bucket.get(key);
    if (existing) existing.push(letter);
    else bucket.set(key, [letter]);
  }

  for (const group of [byJobId, byCompanyKey]) {
    for (const list of group.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  standard.sort((a, b) => b.updatedAt - a.updatedAt);

  return { byJobId, byCompanyKey, standard };
}

export function useJobLetters(): JobLetters {
  const [ready, setReady] = useState(false);
  const [byJobId, setByJobId] = useState<ReadonlyMap<string, LetterRecord[]>>(
    () => new Map(),
  );
  const [byCompanyKey, setByCompanyKey] = useState<ReadonlyMap<string, LetterRecord[]>>(
    () => new Map(),
  );
  const [standard, setStandard] = useState<readonly LetterRecord[]>(() => []);

  // `isStale` lets ONE code path serve both callers: the mount effect passes an
  // unmount guard, an imperative caller passes nothing. It is deliberately
  // absent from `JobLetters.refresh`'s public signature — an extra optional
  // parameter is invisible to consumers, and inventing a second copy of the
  // load just to hold the guard is how the two would drift.
  const refresh = useCallback(async (isStale: () => boolean = () => false) => {
    const grouped = groupByScope(await getAllLetters());
    if (isStale()) return;
    setByJobId(grouped.byJobId);
    setByCompanyKey(grouped.byCompanyKey);
    setStandard(grouped.standard);
    setReady(true);
  }, []);

  useEffect(() => {
    // The IndexedDB read resolves out of band, so it can land after this hook's
    // consumer is gone. Guarded the same way `useSavedJobRatings` guards its own
    // out-of-band pass, so the two sibling hooks on this surface behave alike.
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
    // Deps hand-audited both ways (`exhaustive-deps` is NOT enforced here —
    // CLAUDE.md): `refresh` is the only value read and it is `useCallback`d on
    // `[]`, so this runs once per mount. Nothing else is captured.
  }, [refresh]);

  return { ready, byJobId, byCompanyKey, standard, refresh };
}

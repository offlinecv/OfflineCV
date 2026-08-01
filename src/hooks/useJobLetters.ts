// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJobLetters — every letter in the store, grouped by job (#715).
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
   *  which is the signal `JobLetterIndicator` uses to render nothing. */
  byJobId: ReadonlyMap<string, LetterRecord[]>;
  refresh: () => Promise<void>;
}

export function useJobLetters(): JobLetters {
  const [ready, setReady] = useState(false);
  const [byJobId, setByJobId] = useState<ReadonlyMap<string, LetterRecord[]>>(
    () => new Map(),
  );

  // `isStale` lets ONE code path serve both callers: the mount effect passes an
  // unmount guard, an imperative caller passes nothing. It is deliberately
  // absent from `JobLetters.refresh`'s public signature — an extra optional
  // parameter is invisible to consumers, and inventing a second copy of the
  // load just to hold the guard is how the two would drift.
  const refresh = useCallback(async (isStale: () => boolean = () => false) => {
    const letters = await getAllLetters();
    const grouped = new Map<string, LetterRecord[]>();
    for (const letter of letters) {
      const forJob = grouped.get(letter.jobId);
      if (forJob) forJob.push(letter);
      else grouped.set(letter.jobId, [letter]);
    }
    for (const forJob of grouped.values()) {
      forJob.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (isStale()) return;
    setByJobId(grouped);
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

  return { ready, byJobId, refresh };
}

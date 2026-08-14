// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJourneyProgress — the React half of the journey completion ledger (#826).
 *
 * `lib/journey-progress.ts` owns the decision and the storage; this owns the
 * two things a component needs on top of it: a value that is stable across
 * renders (so `deriveJourney`'s memo is not defeated by a fresh object every
 * keystroke) and a re-read on the one navigation that would otherwise strand a
 * mark on the wrong side of a page boundary.
 *
 * **That navigation is the `/jobs/` → `/` return leg, and it is a bfcache
 * restore.** `match` completes on `/jobs/`; the user then goes Back, and `/` is
 * restored from the frozen page rather than remounted — no effect re-runs, so a
 * value read once at mount is whatever it was BEFORE the trip, and the ✓ the
 * search just earned never appears. `pageshow` is the exact signal (it fires on
 * the initial load and on every bfcache restore), which is why
 * `useTailorHandoff` listens on it for the same leg and the same reason.
 *
 * Reading through a `useMemo` rather than during render on every pass is a
 * cost decision, not a correctness one: the read is a `localStorage.getItem` +
 * `JSON.parse`, and `/`'s inline editor re-renders on every keystroke.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  markJourneyMilestone,
  readJourneyProgress,
  type JourneyMilestone,
} from "../lib/journey-progress.ts";
import type { JourneyCompletion } from "../lib/journey.ts";

export interface JourneyProgress {
  /** What the ledger records for this résumé — feeds `deriveJourney`. */
  completed: JourneyCompletion;
  /** Record a milestone. A no-op for a null key (nothing parsed, so nothing to
   *  key on) and for a milestone already recorded. */
  mark: (milestone: JourneyMilestone) => void;
}

/**
 * @param key The résumé the ledger is read and written under — `fingerprintParse`
 *            of the PRISTINE parse, or `authoring:<generation>`; null while
 *            there is no résumé at all. See `journey-progress.ts`.
 */
export function useJourneyProgress(key: string | null): JourneyProgress {
  const [revision, setRevision] = useState(0);
  const completed = useMemo(
    // `revision` is the whole point of this dep — it is what re-reads storage
    // after a mark or a bfcache restore. Deps hand-audited both directions
    // (`exhaustive-deps` is NOT enforced — CLAUDE.md): `key` and `revision` are
    // the only inputs, and dropping either would freeze the marks at whatever
    // the first render saw.
    () => readJourneyProgress(key),
    [key, revision],
  );

  useEffect(() => {
    const reread = () => setRevision((r) => r + 1);
    window.addEventListener("pageshow", reread);
    return () => window.removeEventListener("pageshow", reread);
    // The handler closes over nothing but `setRevision`, which React guarantees
    // stable, so `[]` is complete. The `pageshow` that fires on the initial
    // load costs one extra render and reads the same value back.
  }, []);

  // Latest-value ref so `mark` can skip a redundant write without taking
  // `completed` as a dep — that object is re-minted on every re-read, and a
  // callback re-minted with it would re-fire the caller's mark effects.
  const completedRef = useRef(completed);
  completedRef.current = completed;

  const mark = useCallback(
    (milestone: JourneyMilestone) => {
      if (key === null) return;
      if (completedRef.current[milestone] === true) return;
      // False when the store refused the write; re-reading then would only
      // confirm the mark is absent, and re-rendering for it buys nothing.
      if (markJourneyMilestone(key, milestone)) setRevision((r) => r + 1);
    },
    [key],
  );

  return { completed, mark };
}

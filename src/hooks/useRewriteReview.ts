// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useRewriteReview — in-memory per-bullet accept/reject/edit decision model for
 * a rewrite proposal (issue #211). Decisions are deliberately in-memory only:
 * persisting accepted edits would mean a cloud round-trip, which the
 * client-side-only constraint rules out.
 *
 * It is told the aligned pairs (from `alignBullets`) up front and owns two maps,
 * both keyed by `AlignedPair.id`:
 *   - `decisions`  — accepted | rejected (absent = undecided).
 *   - `edits`      — per-bullet edited text (an edit auto-accepts its pair).
 *
 * Section/batch actions operate over an explicit id list the caller passes (a
 * section's pair ids, or "all"), so the hook never needs to know the section
 * structure — it just flips entries in the maps.
 *
 * Pure interaction state: no I/O. The actual write-back into the reconstructed
 * résumé is `resolveBulletActions` + the edit primitives, driven by the caller
 * on Apply — this hook only records intent.
 */

import { useCallback, useMemo, useState } from "react";
import type { AlignedPair } from "../lib/rewrite-review/align-bullets.ts";
import {
  acceptedCount as countAccepted,
  type Decision,
  type Decisions,
  type Edits,
} from "../lib/rewrite-review/apply-accepted.ts";

export interface RewriteReview {
  /** Decision per pair id (absent = undecided). */
  decisions: Decisions;
  /** Edited text per pair id (absent = use the proposed text). */
  edits: Edits;
  /** Accept one pair. */
  accept: (id: string) => void;
  /** Reject one pair. */
  reject: (id: string) => void;
  /** Toggle one pair between accepted and not (rejected). Convenience for a
   *  single accept/reject control that flips state. */
  toggle: (id: string) => void;
  /** Set the edited text for one pair; editing auto-accepts it (matches the
   *  source's edit-implies-accept affordance). An empty string clears the edit
   *  (and leaves the pair accepted — Apply falls back to the proposed text). */
  setEdit: (id: string, value: string) => void;
  /** Accept every pair in `ids` (a section's pairs). */
  acceptMany: (ids: readonly string[]) => void;
  /** Reject every pair in `ids` (a section's pairs). */
  rejectMany: (ids: readonly string[]) => void;
  /** Accept every pair in the whole proposal. */
  acceptAll: () => void;
  /** Reject every pair in the whole proposal. */
  rejectAll: () => void;
  /** Clear all decisions and edits back to undecided. */
  reset: () => void;
  /** Count of accepted pairs across the whole proposal. */
  acceptedCount: number;
  /** Decision for one pair, or undefined when undecided. */
  decisionOf: (id: string) => Decision | undefined;
}

export function useRewriteReview(
  pairs: readonly AlignedPair[],
): RewriteReview {
  const [decisions, setDecisions] = useState<Map<string, Decision>>(
    () => new Map(),
  );
  const [edits, setEdits] = useState<Map<string, string>>(() => new Map());

  const allIds = useMemo(() => pairs.map((p) => p.id), [pairs]);

  const setDecision = useCallback((ids: readonly string[], value: Decision) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, value);
      return next;
    });
  }, []);

  const accept = useCallback((id: string) => setDecision([id], "accepted"), [
    setDecision,
  ]);
  const reject = useCallback((id: string) => setDecision([id], "rejected"), [
    setDecision,
  ]);

  const toggle = useCallback((id: string) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(id, prev.get(id) === "accepted" ? "rejected" : "accepted");
      return next;
    });
  }, []);

  const setEdit = useCallback((id: string, value: string) => {
    setEdits((prev) => {
      const next = new Map(prev);
      if (value === "") next.delete(id);
      else next.set(id, value);
      return next;
    });
    // Editing implies accepting — a user only edits a bullet they intend to keep.
    setDecisions((prev) => {
      if (prev.get(id) === "accepted") return prev;
      const next = new Map(prev);
      next.set(id, "accepted");
      return next;
    });
  }, []);

  const acceptMany = useCallback(
    (ids: readonly string[]) => setDecision(ids, "accepted"),
    [setDecision],
  );
  const rejectMany = useCallback(
    (ids: readonly string[]) => setDecision(ids, "rejected"),
    [setDecision],
  );

  const acceptAll = useCallback(
    () => setDecision(allIds, "accepted"),
    [setDecision, allIds],
  );
  const rejectAll = useCallback(
    () => setDecision(allIds, "rejected"),
    [setDecision, allIds],
  );

  const reset = useCallback(() => {
    setDecisions(new Map());
    setEdits(new Map());
  }, []);

  const acceptedCount = useMemo(
    () => countAccepted(pairs, decisions),
    [pairs, decisions],
  );

  const decisionOf = useCallback(
    (id: string) => decisions.get(id),
    [decisions],
  );

  return {
    decisions,
    edits,
    accept,
    reject,
    toggle,
    setEdit,
    acceptMany,
    rejectMany,
    acceptAll,
    rejectAll,
    reset,
    acceptedCount,
    decisionOf,
  };
}

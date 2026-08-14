// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useJourneyGuidance — the interaction state behind the L1 journey rail
 * (issue #812): which stage the user asked for that has nothing behind it yet,
 * where a click is routed, and the scroll that makes the ask legible.
 *
 * Extracted from `PageShell` rather than left inline because this is
 * cross-cutting interaction state — the same class as `useReplaceResumeOnDrop`
 * and `useSectionRewriteLock` beside it, and what CLAUDE.md's "Data & hooks"
 * rule names — while `PageShell` is placement: it decides WHERE the rail and
 * the card sit and nothing about what a stage means or what a click resolves
 * to. The shell was 197 LOC before the rail landed on it; keeping the routing
 * here is also what keeps it under the ~200 LOC line.
 *
 * The one invariant a future edit will otherwise "clean up": **`blockedStage`
 * is derived during render, never carried in an effect.** The card is stale the
 * instant the missing prerequisite lands — a parse finishes, a handoff
 * resolves — and an effect-cleared card survives that by a frame in the
 * ordinary case and FOREVER on the `/jobs/` → `/` bfcache return leg, where the
 * tree is restored without any effect re-running at all (the #783 defect).
 * Only the raw ask is state; whether that ask is still blocked is recomputed
 * from the current journey every render.
 */

import { useState } from "react";
import {
  isStageReachable,
  journeyStage,
  type Journey,
  type JourneyStage,
  type JourneyStageId,
} from "../lib/journey.ts";
import { prefersReducedMotion } from "../lib/anchors.ts";

/** What a surface hands the rail: the derived arc, and what it does about a
 *  stage the user can actually be sent to. */
export interface JourneyNavigation {
  /** The derived arc — see `deriveJourney`. Computed during render by the
   *  surface, never from a mount-only effect. */
  state: Journey;
  /** What this surface does when the user picks a stage it can actually show. */
  onSelect: (id: JourneyStageId) => void;
}

export interface JourneyGuidanceState {
  /** The stage whose empty state should be explained right now, or null. */
  blockedStage: JourneyStage | null;
  /** Every rail click AND the guidance card's own CTA come through here. */
  onStageClick: (id: JourneyStageId) => void;
  /** Close the card without going anywhere. */
  dismiss: () => void;
}

/**
 * Bring the top of the page — which is where the rail, and any guidance card it
 * opens, both live — back into view. A rail click that quietly changed a tab
 * three screens above the user is a click that did nothing.
 *
 * `prefers-reduced-motion` has to be consulted in JS: the CSS `scroll-behavior`
 * cascade does not reach a `behavior: "smooth"` passed here. Shared with
 * `scrollToSection`, which a rail click runs immediately after this one — see
 * `prefersReducedMotion`'s docblock for why the two must not each carry their
 * own copy of the query.
 */
function scrollToJourney(): void {
  const reduced = prefersReducedMotion();
  try {
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  } catch {
    // No real scroller (jsdom, an embedded view) — nothing to bring into view.
  }
}

export function useJourneyGuidance(
  journey?: JourneyNavigation,
): JourneyGuidanceState {
  // The raw ask, and only the raw ask. See the docblock.
  const [askedFor, setAskedFor] = useState<JourneyStageId | null>(null);

  const blockedStage =
    journey !== undefined &&
    askedFor !== null &&
    !isStageReachable(journey.state, askedFor)
      ? journeyStage(askedFor)
      : null;

  // Plain functions, not `useCallback`: `journey` is an object literal rebuilt
  // by the surface on every render, so a memo keyed on it would never hit, and
  // `JourneyRail` renders raw `Button`s that are not memoized either. A
  // `useCallback` here would be a dep array to keep honest for no saved render.
  const onStageClick = (id: JourneyStageId) => {
    if (journey === undefined) return;
    scrollToJourney();
    if (isStageReachable(journey.state, id)) {
      setAskedFor(null);
      journey.onSelect(id);
      return;
    }
    // Ungated, so the click is never swallowed: it opens the stage's empty
    // state instead of the stage. The card's own CTA comes back through here,
    // so a chain (Tailor → Match jobs → Add résumé) resolves one step at a
    // time rather than dead-ending on a prerequisite that is itself unmet.
    setAskedFor(id);
  };

  return { blockedStage, onStageClick, dismiss: () => setAskedFor(null) };
}

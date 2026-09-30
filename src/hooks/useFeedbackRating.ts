// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useFeedbackRating — the "`feedback_rated` fires once per open, whatever the
 * open ends in" bookkeeping for `FeedbackDialog` (#1006), split out to keep
 * that file under CLAUDE.md's ~200 LOC feature-component ceiling.
 *
 * Mints a fresh `openId` (and clears the fired guard) every time `open` flips
 * true, so a snoozed-then-reopened dialog is a new open even without
 * unmounting — see `FeedbackDialog`'s own docblock for why `initialRating` is
 * a dep alongside `open`. `reportDismissed` and `reportSubmitted` are the only
 * two ways `feedback_rated` fires, and each marks the guard before calling
 * `trackFeedbackRated`, so a submit immediately followed by the close handler
 * that always runs on the way out can never double-report.
 */

import { useEffect, useRef } from "react";
import {
  trackFeedback,
  trackFeedbackRated,
  type FeedbackArgs,
} from "../lib/analytics.ts";

export interface FeedbackRatingController {
  openId: string;
  /** Fire `feedback_rated(dismissed)` iff a star was picked and this open
   *  hasn't already reported. Safe to call unconditionally from close. */
  reportDismissed: (rating: number) => void;
  /** Fire `feedback_submitted` and `feedback_rated(submitted)` for a step-2
   *  submission, sharing `openId`. */
  reportSubmitted: (
    rating: number,
    fields: Omit<FeedbackArgs, "rating">,
  ) => void;
}

export function useFeedbackRating(
  open: boolean,
  initialRating: number,
): FeedbackRatingController {
  // A ref, not state: nothing reads `openId` during render, only inside the
  // `reportDismissed`/`reportSubmitted` closures below, so mutating it
  // shouldn't force an extra re-render on every dialog open.
  const openIdRef = useRef("");
  const ratedFiredRef = useRef(false);

  useEffect(() => {
    if (open) {
      // `crypto.randomUUID()` throws in a non-secure context (`npm run
      // dev:http`, a documented LAN-demo mode) — fall back to a Math.random
      // id rather than crashing the dialog open.
      try {
        openIdRef.current = crypto.randomUUID();
      } catch {
        openIdRef.current = Math.random().toString(36).slice(2);
      }
      ratedFiredRef.current = false;
    }
  }, [open, initialRating]);

  function reportDismissed(rating: number): void {
    if (rating >= 1 && !ratedFiredRef.current) {
      ratedFiredRef.current = true;
      try {
        trackFeedbackRated({
          rating,
          openId: openIdRef.current,
          outcome: "dismissed",
        });
      } catch {
        // Best-effort: capture() is fire-and-forget.
      }
    }
  }

  function reportSubmitted(
    rating: number,
    fields: Omit<FeedbackArgs, "rating">,
  ): void {
    // Guarded like `reportDismissed`: a fast double-submit before React swaps
    // to the `thanks` step must not double-fire either event for one open.
    if (ratedFiredRef.current) return;
    ratedFiredRef.current = true;
    // Two separate try/catch blocks: a `trackFeedback` throw must not skip
    // `trackFeedbackRated` (or vice versa) — the guard above is already
    // spent, so a shared `try` would drop `feedback_rated` for this open.
    try {
      trackFeedback({ rating, openId: openIdRef.current, ...fields });
    } catch {
      // Best-effort: capture() is fire-and-forget.
    }
    try {
      trackFeedbackRated({
        rating,
        openId: openIdRef.current,
        outcome: "submitted",
      });
    } catch {
      // Best-effort: capture() is fire-and-forget.
    }
  }

  return { openId: openIdRef.current, reportDismissed, reportSubmitted };
}

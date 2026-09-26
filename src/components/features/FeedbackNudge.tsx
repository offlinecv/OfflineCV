// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FeedbackNudge — the non-modal invitation that replaces #900's automatic modal
 * open (#912).
 *
 * #900 was right that the ask should follow a real success moment and right to
 * keep an always-available `[★ Feedback]` button. The part worth changing is
 * the instrument: it opened `FeedbackDialog` itself, and `Dialog` is a native
 * `showModal()`, so an automatic open takes keyboard focus off whatever the
 * user was doing and reads to a screen reader as an interruption. NN/g's
 * *User-Feedback Requests* endorses task-then-ask and an always-available way
 * in while explicitly discouraging modal popups for the ask itself.
 *
 * So this is the ask, and it is deliberately the smallest thing that can be
 * one: a line of copy and the star row, non-modal, dismissible. Picking a star
 * opens the full dialog on the branch that star routes to — user-initiated,
 * which is when a modal is the right instrument rather than the wrong one.
 *
 * **Where it renders (#1005).** Never in the page flow: a block above `<Result>`
 * is off-screen for a user scrolled deep into the résumé and pushes the docked
 * score card down for everyone else. It sits in the fixed bottom dock instead —
 * `FeedbackNudgeSlot` inside Fix It's dock while that is mounted, which is also
 * where finishing Fix It raises it, and `FeedbackNudgeDock`, a dock of its own,
 * otherwise. The controller tracks which, so exactly one ever draws.
 *
 * **Does not steal focus.** It takes its turn in the tab order rather than
 * pulling focus to itself, which is the whole point of not being a dialog. It is announced by `role="status"` — polite, so a
 * screen reader finishes whatever it was saying about the export the user just
 * completed before mentioning this.
 *
 * Reuse analysis: no new surface. `StarRating` is the same primitive
 * `FeedbackDialog`'s own step 1 uses, so a star means the same thing in both
 * places and the routing threshold lives in one component. `FixItDock` is the
 * page's one fixed bottom dock, reused rather than a second one drawn beside
 * it. The dialog is not duplicated — this hands off to it.
 */

import { useContext, useEffect, useLayoutEffect } from "react";
import { Button, StarRating } from "@design-system";
import {
  FeedbackNudgeContext,
  type FeedbackNudgeController,
} from "../../hooks/useFeedbackDialog.ts";
import { FixItDock } from "./FixItDock.tsx";

interface FeedbackNudgeProps {
  /** Picking a star. Carries the value so the dialog can open on the branch
   *  the user already chose rather than asking them to pick twice. */
  onRate: (rating: number) => void;
  /** "Not now" — a real answer, and the cooldown treats it as one. */
  onDismiss: () => void;
}

export function FeedbackNudge({ onRate, onDismiss }: FeedbackNudgeProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* `role="status"` rather than `alert`: this arrives unprompted, but it
          is an invitation, not a problem — polite means it waits its turn
          instead of cutting off the export result being announced. */}
      <div role="status" className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium text-content-primary">
          How did your resume turn out?
        </p>
        <p className="text-2xs text-content-tertiary">
          One tap. It stays on this page unless you send it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {/* `value={0}` always: this is an entry point, not a control holding
            state. The rating it collects lives in the dialog it opens, and a
            star left lit here after the dialog closed would claim a rating was
            recorded when nothing was sent. */}
        <StarRating
          value={0}
          onChange={onRate}
          ariaLabel="Rate your resume experience from 1 to 5 stars"
        />
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/**
 * The nudge's place inside Fix It's dock. Mounted by both dock panels whether
 * or not a nudge is showing, because mounting is what tells the controller the
 * dock is the host — a layout effect, so the standalone dock never paints for a
 * frame on the way in. `raise` is `FixItFinished`'s: reaching the end of Fix It
 * is itself the milestone.
 */
export function FeedbackNudgeSlot({ raise = false }: { raise?: boolean }) {
  const nudge = useContext(FeedbackNudgeContext);
  const register = nudge?.registerNudgeHost;
  useLayoutEffect(() => register?.(), [register]);
  // Once per mount: `notifyFixItFinished` is re-created every render, and the
  // controller already refuses a second ask for the same parse, so the one
  // captured at mount is the right one and re-running on identity would only
  // re-check.
  useEffect(() => {
    if (raise) nudge?.notifyFixItFinished();
  }, []);
  if (!nudge?.nudgeVisible) return null;
  return (
    <div className="mt-3 border-t border-border-light pt-3">
      <FeedbackNudge onRate={nudge.rateFromNudge} onDismiss={nudge.dismissNudge} />
    </div>
  );
}

/** The nudge in a dock of its own — the export milestone's, when no Fix It dock
 *  is there to host it. `App` renders it only while that is the case. */
export function FeedbackNudgeDock({ nudge }: { nudge: FeedbackNudgeController }) {
  return (
    <FixItDock label="Feedback request">
      <FeedbackNudge onRate={nudge.rateFromNudge} onDismiss={nudge.dismissNudge} />
    </FixItDock>
  );
}

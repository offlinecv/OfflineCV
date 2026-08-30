// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FeedbackNudge — the inline invitation that replaces #900's automatic modal
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
 * one: a line of copy and the star row, inline, dismissible. Picking a star
 * opens the full dialog on the branch that star routes to — user-initiated,
 * which is when a modal is the right instrument rather than the wrong one.
 *
 * **Does not steal focus.** It renders in the normal flow and takes its turn in
 * the tab order rather than pulling focus to itself, which is the whole point
 * of not being a dialog. It is announced by `role="status"` — polite, so a
 * screen reader finishes whatever it was saying about the export the user just
 * completed before mentioning this.
 *
 * Reuse analysis: no new surface. `StarRating` is the same primitive
 * `FeedbackDialog`'s own step 1 uses, so a star means the same thing in both
 * places and the routing threshold lives in one component; `Card` and `Button`
 * are the shared pieces every other inline block on this page is built from.
 * The dialog is not duplicated — this hands off to it.
 */

import { Button, Card, StarRating } from "@design-system";

interface FeedbackNudgeProps {
  /** Picking a star. Carries the value so the dialog can open on the branch
   *  the user already chose rather than asking them to pick twice. */
  onRate: (rating: number) => void;
  /** "Not now" — a real answer, and the cooldown treats it as one. */
  onDismiss: () => void;
}

export function FeedbackNudge({ onRate, onDismiss }: FeedbackNudgeProps) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
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
    </Card>
  );
}

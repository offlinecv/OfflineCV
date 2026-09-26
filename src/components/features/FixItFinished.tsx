// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FixItFinished — the Fix It dock's end state (#810), split out of
 * `FixItToolbar`, which decides when it shows.
 *
 * Two ways in, and the copy must not conflate them. Edits that empty the
 * guidance list resolved everything. Stepping past the last item only means the
 * user has seen everything: the items are still open, so the panel says how
 * many and offers the way back rather than claiming they are resolved.
 *
 * Focus: stepping past the end unmounts the Next button the user pressed, so
 * focus would fall to `<body>`; the panel takes it on Done. When edits emptied
 * the list, focus is still in the résumé field the user edited, and stays.
 */

import { useEffect, useRef } from "react";
import { Button } from "@design-system";
import { FixItDock } from "./FixItDock.tsx";
import { FeedbackNudgeSlot } from "./FeedbackNudge.tsx";

export function FixItFinished({
  remaining,
  onBack,
  onExit,
}: {
  /** Guidance items still open; 0 when edits resolved them all. */
  remaining: number;
  /** Return to the last item. Omitted when there is none to return to. */
  onBack?: () => void;
  onExit: () => void;
}) {
  const resolved = remaining === 0;
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      panelRef.current
        ?.querySelector<HTMLElement>("[data-fixit-done]")
        ?.focus();
    }
  }, []);
  return (
    <FixItDock label="Fix It guidance complete">
      <div ref={panelRef} className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {resolved && (
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-feedback-success-bg text-sm font-bold text-feedback-success-text"
              aria-hidden="true"
            >
              ✓
            </span>
          )}
          <div>
            <p className="text-sm font-semibold text-content-primary">
              {resolved
                ? "All guidance items resolved!"
                : "You've stepped through every item"}
            </p>
            <p className="text-xs text-content-secondary">
              {resolved
                ? "Your score already includes these edits."
                : `${remaining} ${remaining === 1 ? "item is" : "items are"} still open. Your score updates as you edit.`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onBack && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onBack}
              aria-label="Back to the last guidance item"
            >
              ← Back
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={onExit}
            data-fixit-done
            aria-label="Finish Fix It mode"
          >
            Done
          </Button>
        </div>
      </div>
      <FeedbackNudgeSlot raise />
    </FixItDock>
  );
}

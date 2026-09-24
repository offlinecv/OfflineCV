// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FixItButton — the one entry into guided Fix It mode (#810), shared by both
 * states of the score widget.
 *
 * The expanded readout (`AtsScoreReadout`) and the docked strip
 * (`CollapsedScoreBar`) both render it, and they must agree: the widget docks
 * itself ~4.5s after arrival, so the strip is the state nearly every user
 * acts from, and a button that changed rung or name across the dock would
 * read as two different actions. One component, so the variant rule and the
 * accessible name have one definition.
 *
 * The rung follows the verdict band: `primary` below 60, where fixing is the
 * page's main job, `secondary` above it, where the résumé is already sound and
 * the button is an offer rather than the next step. Nothing else on the score
 * card may sit on `primary` beside it — see `LlmEscapeHatchPanel`.
 *
 * The "N things to fix" lead-in is visible text only; the docked strip hides
 * it below `sm` through `countClassName`, where its one-line row has no width
 * for it. The button's accessible name carries the count at every width.
 */

import { Button } from "@design-system";
import type { ScoreTier } from "../../lib/score/score.ts";

interface FixItButtonProps {
  count: number;
  tier: ScoreTier;
  onEnter: () => void;
  /** Classes for the "N things to fix" lead-in; the docked strip passes its
   *  breakpoint gate here. */
  countClassName?: string;
}

export function FixItButton({
  count,
  tier,
  onEnter,
  countClassName = "",
}: FixItButtonProps) {
  const things = count === 1 ? "thing" : "things";
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span
        className={`whitespace-nowrap text-xs font-medium text-content-secondary ${countClassName}`}
      >
        {count} {things} to fix
      </span>
      <Button
        variant={tier === "low" ? "primary" : "secondary"}
        size="sm"
        onClick={onEnter}
        className="whitespace-nowrap"
        aria-label={`Fix It mode: ${count} ${things} to fix`}
      >
        Fix It →
      </Button>
    </div>
  );
}

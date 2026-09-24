// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ScoreDetails — the score readout PLUS everything that docks away with it
 * (#955).
 *
 * `AtsScoreReadout` owned `useAutoCollapse` until this module existed, so the
 * only thing that docked was the readout itself. The user's decision is that
 * "score details" means more than the ring: the recovery offer, the targeting
 * and improvements disclosure, and the local-AI feedback disclosure are all
 * part of the same diagnostic, and all four collapse to one line together,
 * leaving the score card as `ParsedHeader` + the docked pill. The toggle's own
 * accessible name already promised as much — `Expand score details` /
 * `Collapse score details` (`scoreToggleLabels.ts`) — so this module is what
 * makes the label true.
 *
 * Three constraints shape the JSX, and each of them is a silent failure if
 * undone:
 *
 *  1. **The details region is a SIBLING of the hero `<section>`, never a
 *     child.** `e2e/support/score-hero.ts` locates the hero as the toggle
 *     button's nearest `<section>` ancestor and `e2e/viewport.spec.ts` bounds
 *     its height; `measureDockedStrip` additionally reads the docked row as
 *     the hero section's `:scope > div`. Putting this content inside
 *     `AtsScoreReadout`'s own section would blow the height ceiling and hand
 *     the docked-strip probe the wrong element — with nothing here to say so.
 *     The wrapper below is a plain `<div>` for the same reason: `Card` renders
 *     a `<section>`, and the spec's `scoreCard()` walks one `<section>`
 *     ancestor up from the hero to find it.
 *
 *  2. **`guardProps` goes on the wrapper, which contains BOTH.**
 *     `useAutoCollapse`'s docblock: "Collapsing content out from under someone
 *     who is still reading it is a defect," and hover AND focus both hold. The
 *     details region is the part a reader spends the longest in — it is where
 *     the findings are — so a hold scoped to the hero alone would dock the
 *     card mid-read, and `onBlur`'s `contains(relatedTarget)` check would
 *     additionally treat a tab from the ring into the targeting disclosure as
 *     leaving. That is why `AtsScoreReadout` is CONTROLLED here rather than
 *     owning the hook: two elements cannot both be the guarded root.
 *
 *  3. **The region stays MOUNTED when docked — `hidden`, never a conditional
 *     render.** Unmounting `ResumeQualityPanel` discards a critique that cost
 *     a ~1.2 GB model download plus inference, and the docking trigger is a
 *     4.5s idle timer, so the discard would be routine rather than rare. Same
 *     rule, same reason, as `Tabs`' inactive panels and `ResultDetail`'s
 *     disclosures. Tailwind's preflight makes `[hidden]` `display: none
 *     !important`, so the layout win is identical to unmounting and the
 *     `flex`/`gap-6` classes on the same element are inert while docked.
 *     `empty:hidden` (specificity 0,2,0, so it beats `.flex`) keeps a region
 *     with nothing in it from contributing a phantom `gap-6` — every child
 *     here self-hides, so "nothing to show" is a normal state.
 *
 * `score: null` is the #313 reveal gate, not a loading state: a blank authored
 * résumé shows `placeholder` where the readout would be. The details region
 * stays OPEN in that state, because with no readout there is no toggle to
 * reopen it with — and it is one subtree either way, so crossing the reveal
 * threshold mid-edit does not remount the children.
 *
 * The countdown is PAUSED in that state, not merely masked (#955 review).
 * Authoring toward the threshold takes far longer than the 4.5s idle timer and
 * scrolls far more than 40px, so a countdown left running had always fired by
 * the reveal: the readout arrived already docked and the targeting region
 * above the résumé vanished in the same render, under the author's cursor.
 * The reveal is the arrival; the clock starts there.
 */

import type { ReactNode } from "react";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import { useAutoCollapse } from "../../hooks/useAutoCollapse.ts";
import { AtsScoreReadout } from "./AtsScoreReadout.tsx";

export interface ScoreDetailsProps {
  /** The graded score, or `null` when the #313 reveal threshold is unmet. */
  score: AnonymousAtsScore | null;
  /** Rendered in the readout's slot while `score` is null. Optional: the
   *  authoring lane shows nothing at all until the threshold is cleared. */
  placeholder?: ReactNode;
  /** Force an initial docked state (defaults to the post-drop reveal). */
  defaultCollapsed?: boolean;
  /** Identity of the PARSE behind `score` — a new résumé is a new reveal; an
   *  edit to the same one is not. It must not be derived from the score, which
   *  re-grades on every override; see `useAutoCollapse`'s `resetKey`. The
   *  parse lane passes `parseIdentity`, the authoring lane `parseKey`. */
  resetKey?: unknown;
  /** Count of outstanding score guidance items (#810). */
  guidanceCount?: number;
  /** Enters guided Fix It step-through mode on the résumé view (#810). */
  onEnterFixIt?: () => void;
  /** The score details themselves — the recovery offer, targeting, local-AI
   *  feedback. Every one of them self-hides when it has nothing to say. */
  children?: ReactNode;
}

export function ScoreDetails({
  score,
  placeholder,
  defaultCollapsed = false,
  resetKey,
  guidanceCount,
  onEnterFixIt,
  children,
}: ScoreDetailsProps) {
  const { collapsed, toggle, guardProps } = useAutoCollapse({
    defaultCollapsed,
    resetKey,
    // Nothing can dock before there is a readout to dock to.
    paused: score === null,
  });

  // No readout means no toggle, so nothing could reopen a docked region. The
  // pause above keeps `collapsed` from turning true in that window; this
  // guard covers `defaultCollapsed`, which a widget mounted paused keeps.
  const docked = score !== null && collapsed;

  return (
    <div className="flex flex-col gap-6" {...guardProps}>
      {score !== null ? (
        <AtsScoreReadout
          score={score}
          collapsed={collapsed}
          onToggle={toggle}
          guidanceCount={guidanceCount}
          onEnterFixIt={onEnterFixIt}
        />
      ) : (
        placeholder
      )}
      <div hidden={docked} className="flex flex-col gap-6 empty:hidden">
        {children}
      </div>
    </div>
  );
}

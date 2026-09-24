// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * AtsScoreReadout — the two-state score widget (#953), controlled by
 * `ScoreDetails` since #955.
 *
 * Renders the score in two distinct states:
 * 1. Full Reveal (Expanded): 84px ScoreRing, verdict headline, full recommendation,
 *    and three detailed dimension rows with progress tracks.
 * 2. Docked Strip (Collapsed): compact score pill with live score and band, inline
 *    dimension metrics, Popover explainer, and expand toggle via `CollapsedScoreBar`.
 *
 * CONTROLLED since #955: `collapsed` and `onToggle` are props, and the
 * lifecycle behind them — countdown, scroll, hover/focus hold, user-decision
 * lock — lives in `ScoreDetails`, which calls `useAutoCollapse` and spreads
 * `guardProps` on a wrapper holding this widget AND the score details beside
 * it. This component owned the hook until then, which scoped the hold to the
 * ring alone; once the recovery offer, the targeting disclosure and the
 * local-AI feedback moved into the same collapse group, a hold that stopped at
 * this section's edge would dock the card out from under someone reading the
 * findings — the exact defect `useAutoCollapse`'s docblock is written against.
 * Two elements cannot both be the guarded root, so the hook went up.
 *
 * Nothing but the score belongs inside this `<section>`. `e2e/support/
 * score-hero.ts` resolves the hero as the toggle button's nearest `<section>`
 * ancestor, `e2e/viewport.spec.ts` bounds its height, and `measureDockedStrip`
 * reads the docked row as its `:scope > div` — so content added here breaks
 * three probes at once. It goes in `ScoreDetails`' sibling region instead.
 *
 * The two states are SEPARATE SUBTREES, which is why the toggle moves focus by
 * hand. Activating `Collapse ▴` unmounts the very button that was pressed, so
 * without the restore below focus falls to `<body>` and a keyboard user has to
 * tab in from the top of the document after every toggle. `Popover` — added in
 * this same change — restores focus for this same reason; a control that
 * replaces itself owes the same.
 */

import { useEffect, useRef } from "react";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import { getScoreTier } from "../../lib/score/score.ts";
import { getScoreRecommendation } from "../../lib/score/recommendation.ts";
import { Button } from "@design-system";
import { ScoreRing } from "./ScoreRing.tsx";
import { VerdictHeader } from "./VerdictHeader.tsx";
import {
  ScoreDimensionRow,
  formatCompletenessHint,
} from "./ScoreDimensionRow.tsx";
import {
  CollapsedScoreBar,
  ScoreExplainerPopover,
} from "./CollapsedScoreBar.tsx";
import { EXPAND_LABEL, COLLAPSE_LABEL } from "./scoreToggleLabels.ts";
import { FixItButton } from "./FixItButton.tsx";
import { timeAgo } from "../../lib/date-utils.ts";

export interface AtsScoreReadoutProps {
  score: AnonymousAtsScore;
  /** Which of the two states to render. Owned by `ScoreDetails`, whose
   *  `useAutoCollapse` also decides WHEN it changes — the countdown, the
   *  scroll, the hover/focus hold and the user lock are all up there, because
   *  the guarded element has to contain the score details too. */
  collapsed: boolean;
  /** A USER toggle: `useAutoCollapse.toggle`, which locks out the timer and
   *  the scroll listener for good. Only the two buttons below call it — an
   *  automatic dock arrives as a `collapsed` change with no call, which is
   *  what keeps the focus restore below off the automatic path. */
  onToggle: (collapsed: boolean) => void;
  /** Count of outstanding score guidance items (#810). */
  guidanceCount?: number;
  /** Enters guided Fix It step-through mode on the résumé view (#810). */
  onEnterFixIt?: () => void;
}

export function AtsScoreReadout({
  score,
  collapsed,
  onToggle,
  guidanceCount,
  onEnterFixIt,
}: AtsScoreReadoutProps) {
  const rootRef = useRef<HTMLElement>(null);
  // Only a USER toggle moves focus. An automatic dock — the countdown or a
  // scroll — must not, or the page would yank focus away from whatever the
  // reader had moved on to.
  const restoreFocus = useRef(false);

  const userToggle = (next: boolean) => {
    restoreFocus.current = true;
    onToggle(next);
  };

  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const label = collapsed ? EXPAND_LABEL : COLLAPSE_LABEL;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      ?.focus();
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md). `collapsed` is a prop now rather than local state, which
    // changes nothing here: it is still the value the restore reads and still
    // the only one whose change should run it. `restoreFocus` is a ref, read
    // at call time; adding it would be inert. The labels are module
    // constants.
  }, [collapsed]);

  const buildDate = __BUILD_DATE__.slice(0, 10);
  const buildAgo = timeAgo(__BUILD_DATE__) || buildDate;

  const specificityHint = `${score.specificity.metricBullets}/${score.specificity.totalBullets} bullets carry a metric`;
  const structureHint = `verb-led ${score.structure.verbLedBullets}/${score.structure.totalBullets} · length ${score.structure.inWindowBullets}/${score.structure.totalBullets}`;
  const completenessHint = formatCompletenessHint(score.completeness);
  const recommendation = getScoreRecommendation(score);

  const tier = getScoreTier(score.overall);
  const hasFixIt =
    guidanceCount !== undefined && guidanceCount > 0 && onEnterFixIt;

  if (collapsed) {
    return (
      // No wrapper and no second child: `measureDockedStrip` reads the docked
      // row as this section's `:scope > div`.
      <section ref={rootRef}>
        <CollapsedScoreBar
          score={score}
          onExpand={() => userToggle(false)}
          fixIt={
            hasFixIt ? (
              <FixItButton
                count={guidanceCount}
                tier={tier}
                onEnter={onEnterFixIt}
                countClassName="hidden sm:inline"
              />
            ) : undefined
          }
        />
      </section>
    );
  }

  const fixIt = hasFixIt ? (
    <FixItButton count={guidanceCount} tier={tier} onEnter={onEnterFixIt} />
  ) : null;

  return (
    <section ref={rootRef} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
            Your resume score
          </h2>
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-content-secondary">
            alpha
          </span>
          <ScoreExplainerPopover />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => userToggle(true)}
          // `text-xs` omitted deliberately: `Button` appends `className`, the
          // repo ships no `tailwind-merge`, and `SIZE.sm`'s `text-sm` is
          // emitted later — so it never applied.
          className="text-content-secondary hover:text-content-primary"
          aria-label={COLLAPSE_LABEL}
        >
          Collapse ▴
        </Button>
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="flex items-center gap-4 md:min-w-0 md:flex-1">
          <ScoreRing score={score.overall} size={84} />
          <div className="flex flex-col justify-center gap-1">
            <VerdictHeader score={score.overall} recommendation={recommendation} />
            {fixIt && <div className="pt-0.5">{fixIt}</div>}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <ScoreDimensionRow
            label="Specificity"
            value={score.specificity.score}
            max={score.specificity.max}
            gradable={score.specificity.gradable}
            hint={specificityHint}
            anchor="#reconstructed-resume"
          />
          <ScoreDimensionRow
            label="Structure"
            value={score.structure.score}
            max={score.structure.max}
            gradable={score.structure.gradable}
            hint={structureHint}
            anchor="#reconstructed-resume"
          />
          <ScoreDimensionRow
            label="Completeness"
            value={score.completeness.score}
            max={score.completeness.max}
            gradable={score.completeness.gradable}
            hint={completenessHint}
            anchor="#contact"
          />
        </div>
      </div>

      <p className="text-2xs text-content-muted">
        {score.layout.multiplier < 1 && (
          <span className="text-feedback-warning-text">
            Layout penalty ×{score.layout.multiplier.toFixed(2)} (pre-layout{" "}
            {score.preLayoutOverall}) ·{" "}
          </span>
        )}
        {score.algoVersion && <>algo v{score.algoVersion} · </>}Built{" "}
        <span title={buildDate}>{buildAgo}</span>
      </p>
    </section>
  );
}

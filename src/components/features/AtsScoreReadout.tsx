// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * AtsScoreReadout — self-contained, auto-collapsing score widget (#953).
 *
 * Renders the score in two distinct states:
 * 1. Full Reveal (Expanded): 84px ScoreRing, verdict headline, full recommendation,
 *    and three detailed dimension rows with progress tracks.
 * 2. Docked Strip (Collapsed): compact score pill with live score and band, inline
 *    dimension metrics, Popover explainer, and expand toggle via `CollapsedScoreBar`.
 *
 * The collapse lifecycle — countdown, scroll, hover/focus hold, and the
 * user-decision lock — belongs to `useAutoCollapse`, not to this component.
 * `guardProps` must be spread on BOTH states' root: the hold is what keeps the
 * widget from docking out from under someone who is still reading it, and a
 * state that forgets to spread it silently loses that for keyboard users first.
 *
 * The two states are SEPARATE SUBTREES, which is why the toggle moves focus by
 * hand. Activating `Collapse ▴` unmounts the very button that was pressed, so
 * without the restore below focus falls to `<body>` and a keyboard user has to
 * tab in from the top of the document after every toggle. `Popover` — added in
 * this same change — restores focus for exactly this reason; a control that
 * replaces itself owes the same.
 */

import { useEffect, useRef } from "react";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import { getScoreRecommendation } from "../../lib/score/recommendation.ts";
import { Button } from "@design-system";
import { useAutoCollapse } from "../../hooks/useAutoCollapse.ts";
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
import { timeAgo } from "../../lib/date-utils.ts";

export interface AtsScoreReadoutProps {
  score: AnonymousAtsScore;
  /** Force an initial collapsed state (defaults to false for post-drop reveal). */
  defaultCollapsed?: boolean;
  /** Identity of the PARSE behind `score` — a new résumé is a new reveal; an
   *  edit to the same one is not.
   *
   *  It must not be derived from the score. `score` is re-graded by
   *  `useAnalyzedResume`'s `applyOverrides → re-score` memo on every override,
   *  so keying the reveal on it re-expanded the docked widget whenever an edit
   *  moved the number by a point — pushing the résumé being typed in down, then
   *  back up 4.5s later, twice per edit (#956 review). The parse lane passes
   *  `recovery.parseIdentity`, which also changes when a recovery pass lands —
   *  genuinely a new reveal. Omitting it disables the re-reveal entirely. */
  resetKey?: unknown;
}

export function AtsScoreReadout({
  score,
  defaultCollapsed = false,
  resetKey,
}: AtsScoreReadoutProps) {
  const { collapsed, toggle, guardProps } = useAutoCollapse({
    defaultCollapsed,
    // A new parse is a new reveal: re-expand and re-arm so the next résumé gets
    // its own read time rather than arriving into a docked strip.
    resetKey,
  });

  const rootRef = useRef<HTMLElement>(null);
  // Only a USER toggle moves focus. An automatic dock — the countdown or a
  // scroll — must not, or the page would yank focus away from whatever the
  // reader had moved on to.
  const restoreFocus = useRef(false);

  const userToggle = (next: boolean) => {
    restoreFocus.current = true;
    toggle(next);
  };

  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const label = collapsed ? EXPAND_LABEL : COLLAPSE_LABEL;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      ?.focus();
  }, [collapsed]);

  const buildDate = __BUILD_DATE__.slice(0, 10);
  const buildAgo = timeAgo(__BUILD_DATE__) || buildDate;

  const specificityHint = `${score.specificity.metricBullets}/${score.specificity.totalBullets} bullets carry a metric`;
  const structureHint = `verb-led ${score.structure.verbLedBullets}/${score.structure.totalBullets} · length ${score.structure.inWindowBullets}/${score.structure.totalBullets}`;
  const completenessHint = formatCompletenessHint(score.completeness);
  const recommendation = getScoreRecommendation(score);

  if (collapsed) {
    return (
      <section ref={rootRef} {...guardProps}>
        <CollapsedScoreBar score={score} onExpand={() => userToggle(false)} />
      </section>
    );
  }

  return (
    <section ref={rootRef} className="flex flex-col gap-2" {...guardProps}>
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
          <VerdictHeader score={score.overall} recommendation={recommendation} />
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

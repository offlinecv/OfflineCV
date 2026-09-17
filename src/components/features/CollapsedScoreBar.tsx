// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CollapsedScoreBar — the docked 1-line strip for the score widget (#953).
 *
 * Renders live score badge, inline dimension metrics with section anchor links,
 * the scoring explainer popover, and an expand toggle. Takes ~38px height.
 *
 * `ScoreExplainerPopover` lives here rather than beside its other caller
 * because this file owns the explainer TEXT, and the two must not drift: the
 * popover is the one keyboard-reachable place the scoring rules are written
 * down, so anything that would otherwise be hidden in a hover-only `title`
 * belongs in it.
 */

import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import {
  getScoreLabel,
  getScoreTier,
  BULLET_LENGTH_MIN_WORDS,
  BULLET_LENGTH_MAX_WORDS,
} from "../../lib/score/score.ts";
import type { SectionAnchor } from "../../lib/anchors.ts";
import { Button, Popover } from "@design-system";
import { scoreBandBgClass, scoreBandTextClass, scoreBandParts } from "./scoreBand.ts";
import { EXPAND_LABEL } from "./scoreToggleLabels.ts";

export interface CollapsedScoreBarProps {
  score: AnonymousAtsScore;
  onExpand: () => void;
}

// Not exported: the single consumer is `ScoreExplainerPopover`, directly below.
// Exporting it made it dead weight the dead-code gate flags, and invited a
// second renderer of the same prose that could fall out of step with this one.
const SCORING_EXPLAINER =
  "Scored from what a generic text extractor pulled from your PDF — the same " +
  "starting point most ATS parsers use. Not a universal score; systems weigh " +
  "things differently, and the dimensions below show where the points landed. " +
  "Structure counts a bullet as sound when it opens with an action verb and " +
  `runs ${BULLET_LENGTH_MIN_WORDS}–${BULLET_LENGTH_MAX_WORDS} words.`;

export function ScoreExplainerPopover({
  align,
}: {
  /** Forwarded to `Popover`. The docked strip puts this trigger in the last
   *  group of a `justify-between` row — and below `sm` the middle group is
   *  hidden, pinning it to the right edge — so it opens `end`. The expanded
   *  readout's header row is left-aligned and keeps the default. */
  align?: "start" | "end";
}) {
  return (
    <Popover
      label="How is this scored?"
      align={align}
      triggerContent={<span aria-hidden="true">ⓘ</span>}
    >
      <p className="text-sm text-content-secondary">{SCORING_EXPLAINER}</p>
    </Popover>
  );
}

interface CompactDimensionProps {
  label: string;
  value: number;
  max: number;
  gradable: boolean;
  anchor: SectionAnchor;
}

function CompactDimension({
  label,
  value,
  max,
  gradable,
  anchor,
}: CompactDimensionProps) {
  const { pct, barCls, valueCls } = scoreBandParts(value, max);

  return (
    <a
      href={anchor}
      className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-surface-subtle"
    >
      <span className="text-2xs font-semibold uppercase tracking-wider text-content-muted group-hover:text-content-primary">
        {label}
      </span>
      {gradable ? (
        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-subtle">
          <div
            className={`h-full rounded-full ${barCls}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : (
        <span className="text-2xs text-content-muted">—</span>
      )}
      {gradable && (
        <span className="text-xs font-medium tabular-nums">
          <span className={valueCls}>{value}</span>
          <span className="text-content-muted">/{max}</span>
        </span>
      )}
    </a>
  );
}

export function CollapsedScoreBar({ score, onExpand }: CollapsedScoreBarProps) {
  const tier = getScoreTier(score.overall);
  const tierLabel = getScoreLabel(tier);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onExpand}
          // `p-0` dropped: `Button` appends `className` and the repo ships no
          // `tailwind-merge`, and Tailwind emits `px-*`/`py-*` after the `p-*`
          // shorthand — so ghost's own `px-2 py-0.5` won and `p-0` was inert
          // while reading as though it did something.
          className="h-auto rounded-full hover:bg-transparent"
          // The label carries the VALUE, not just the action. `aria-label`
          // overrides an element's contents for its accessible name, so a bare
          // "Expand score details" left the score, its denominator and its band
          // unreadable to a screen reader — and because the widget docks itself
          // a few seconds after arrival, that is the state nearly every user
          // ends up in, so the score became unhearable entirely.
          aria-label={`Resume score ${score.overall} out of 100, ${tierLabel}. Expand score details.`}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-light bg-surface-subtle px-2.5 py-0.5 text-xs font-medium">
            <span className="font-bold text-content-primary tabular-nums">
              {score.overall}
            </span>
            <span className="text-2xs font-normal text-content-muted">/100</span>
            <span className="text-content-muted" aria-hidden="true">
              ·
            </span>
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${scoreBandBgClass(tier)}`}
              aria-hidden="true"
            />
            <span
              className={`text-2xs font-semibold uppercase tracking-wider ${scoreBandTextClass(tier)}`}
            >
              {tierLabel}
            </span>
          </span>
        </Button>
        {score.layout.multiplier < 1 && (
          // No `title` here: it would only repeat the visible text to a mouse
          // user and say nothing to anyone else.
          <span className="text-2xs text-feedback-warning-text">
            (layout penalty ×{score.layout.multiplier.toFixed(2)})
          </span>
        )}
      </div>

      {/* Hidden below `sm`, where the strip has no room for three tracks. The
          dimension detail is not lost — it is one tap away behind the expand
          control, which is always visible. */}
      <div className="hidden sm:flex items-center gap-2 text-xs text-content-secondary">
        <CompactDimension
          label="Specificity"
          value={score.specificity.score}
          max={score.specificity.max}
          gradable={score.specificity.gradable}
          anchor="#reconstructed-resume"
        />
        <span className="text-content-muted" aria-hidden="true">
          ·
        </span>
        <CompactDimension
          label="Structure"
          value={score.structure.score}
          max={score.structure.max}
          gradable={score.structure.gradable}
          anchor="#reconstructed-resume"
        />
        <span className="text-content-muted" aria-hidden="true">
          ·
        </span>
        <CompactDimension
          label="Completeness"
          value={score.completeness.score}
          max={score.completeness.max}
          gradable={score.completeness.gradable}
          anchor="#contact"
        />
      </div>

      <div className="flex items-center gap-2">
        <ScoreExplainerPopover align="end" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onExpand}
          // `text-xs` omitted for the same reason as `p-0` above — `SIZE.sm`'s
          // `text-sm` is emitted later and wins, so it never applied.
          className="text-content-secondary hover:text-content-primary"
          // The shared constant, not a hand-written copy: `AtsScoreReadout`'s
          // focus restore resolves this button by exact `aria-label` match, so
          // a local string here would break the restore silently on a rename.
          aria-label={EXPAND_LABEL}
        >
          Score details ▾
        </Button>
      </div>
    </div>
  );
}

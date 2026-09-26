// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CollapsedScoreBar — the docked 1-line strip for the score widget (#953).
 *
 * Renders live score badge, inline dimension metrics with section anchor links,
 * the scoring explainer popover, and an expand toggle. Measures 26px tall at
 * every width and score regime the e2e matrix covers — the ceiling that
 * defends that is `DOCKED_MAX_PX` in `e2e/support/score-hero.ts`.
 *
 * `ScoreExplainerPopover` lives here rather than beside its other caller
 * because this file owns the explainer TEXT, and the two must not drift: the
 * popover is the one keyboard-reachable place the scoring rules are written
 * down, so anything that would otherwise be hidden in a hover-only `title`
 * belongs in it.
 *
 * One line, structurally, not by text-metric luck (#960). The root is
 * `flex-nowrap`: the score pill (group 1) and the `ⓘ`/`Score details ▾`
 * toggle (group 3) are `shrink-0` and never give up their row, because the
 * toggle is the only route back to the expanded state and the widget docks
 * itself ~4.5s after arrival — the toggle is what nearly every user sees.
 * The dimension tracks (group 2) are the one group sized to what is left
 * over — but sized to FIT it, never to be clipped into it; see the comment
 * on that group for the width budget. To keep group 1's width independent of
 * the score DATA (not just of the wrap decision), the docked pill's verdict
 * word sits in a FIXED-width slot (`w-5` below `sm`, `sm:w-28` at `sm`+)
 * instead of at its own intrinsic width, and `truncate` keeps that slot from
 * wrapping its two-word label back into a second line — a fixed-width box
 * holding "Getting There" is the same wrap bug one level down, and it needs
 * no code change to trigger. Dropping the word to color-only (an earlier
 * version of this fix, and a regression #965 briefly reintroduced below `sm`)
 * is a WCAG 1.4.1 violation, since the coloured dot next to it was always
 * supplementary to the word, never a stand-in for it (#988). Below `sm` the
 * slot is narrower, not absent — but its width is bounded by group 2, not by
 * the verdict word's own legibility: an earlier `w-14` (56px), sized only to
 * clear "Strong" (48.6px) whole, ships fine when group 2 is the dimension
 * tiles (`hidden` below `lg`, so it contributes nothing to the row at this
 * width) but steals 56px from the SAME row's budget when group 2 is the Fix
 * It entry instead — which, unlike the tiles, has no width gate and renders
 * at every width (see that group's comment). `expectDockedStripIsOneLine`
 * caught this at 375px in all three `MOBILE_REGIMES` fixtures (#988 follow-up):
 * the Fix It button alone needs 73–75px there, and `w-14` left only 44px for
 * it. `w-5` (20px) gives that back — measured 5–8px of slack across those
 * three regimes, real margin rather than an exact fit — at the cost of
 * truncating "Strong" too, not just the two longer labels; the pill's
 * `aria-label` still carries the untruncated band regardless of width.
 * The optional `(layout penalty ×N.NN)` span is removed outright (not just
 * re-slotted); it still surfaces in the expanded `AtsScoreReadout` footer.
 *
 * When there is score guidance, group 2 is the Fix It entry (#810) instead of
 * the dimension tiles, at every width — see the comment on that group.
 */

import type { ReactNode } from "react";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import {
  getScoreLabel,
  getScoreTier,
  BULLET_LENGTH_MIN_WORDS,
  BULLET_LENGTH_MAX_WORDS,
} from "../../lib/score/score.ts";
import type { ScoreTileAnchor } from "../../lib/anchors.ts";
import { Button, Popover } from "@design-system";
import { scoreBandBgClass, scoreBandTextClass, scoreBandParts } from "./scoreBand.ts";
import { EXPAND_LABEL } from "./scoreToggleLabels.ts";

export interface CollapsedScoreBarProps {
  score: AnonymousAtsScore;
  onExpand: () => void;
  /** The Fix It entry (#810), when there is guidance to step through. It
   *  takes the dimension tiles' slot — see the group comment below. */
  fixIt?: ReactNode;
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
   *  group of the row, pinned to the right edge by `ml-auto` (#680), so it
   *  is flush right at every width whether the middle group holds Fix It or
   *  the dimension tiles — hence `end`. The expanded readout's header row is
   *  left-aligned and keeps the default. */
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
  anchor: ScoreTileAnchor;
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
        // `w-6` (24px), not the `w-12` (48px) this track shipped with: the
        // three tiles have a hard, viewport-independent width budget in the
        // docked row (see the group comment below) and the track is the only
        // part of a tile that can give width back without either abbreviating
        // a label or dropping the value — and it is the redundant part, since
        // the exact number sits immediately to its right. Measured across all
        // six `SCORE_REGIMES` fixtures, this is what takes the group from
        // 580–589px (over budget in every regime) to 486–496px.
        <div className="h-1.5 w-6 overflow-hidden rounded-full bg-surface-subtle">
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

export function CollapsedScoreBar({
  score,
  onExpand,
  fixIt,
}: CollapsedScoreBarProps) {
  const tier = getScoreTier(score.overall);
  const tierLabel = getScoreLabel(tier);

  return (
    // No `justify-between` (#680): that split the row's leftover width into
    // TWO gaps, one on each side of the middle group, which floated Fix It
    // (a much narrower group than the dimension tiles it replaces, #810) away
    // from the score pill it acts on instead of sitting right after it. A
    // plain `gap-3` row plus `ml-auto` on the last group collapses that to
    // ONE gap — before the last group, holding it at the right edge — so the
    // score pill and Fix It (or the tiles) always sit their fixed `gap-3`
    // apart regardless of how much room the row has.
    <div className="flex flex-nowrap items-center gap-3 text-sm">
      <div className="flex shrink-0 items-center gap-2">
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
          // ends up in, so the score became unhearable entirely. The visible
          // pill's verdict word (below) reads at every width too (#988); this
          // label is the accessible-name copy screen readers use instead of it.
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
            {/* Colour is never the SOLE carrier of the band (WCAG 1.4.1) — the
                dot above is supplementary, this word is the actual signal, at
                every width (#988). `w-28`/`w-14` (not the label's own
                intrinsic width) is what keeps group 1's width constant across
                all three bands — the actual fix for the wrap (#960). Measured
                natural widths against the real compiled CSS: "Strong" 48.6px,
                "Needs Work" 76.8px, "Getting There" 89.3px, so `sm:w-28`
                (112px) clears the widest by 22.7px at `sm`+.
                `truncate` is load-bearing, not cosmetic. A fixed-width slot
                holding a TWO-WORD label is a wrap waiting to happen: the
                span defaulted to `white-space: normal`, so as soon as the
                label needs more than the slot it breaks at its space, becomes
                two lines, and re-inflates the pill — the exact failure class
                this whole layer exists to eliminate, reintroduced one level
                down. That is reachable without any code change: Chrome's
                minimum-font-size setting raises 11px text while `rem`-based
                widths stay put, and 14px is enough, since 89.3 × 14/11 =
                113.7px > 112px. Measured at 1280 with only this span's
                font-size varied, before `truncate`: 13px → 27.3px tall,
                14px → 47.3px (wrapped), 16px → 52.7px, 18px → 58px. With
                `truncate` the label clips to an ellipsis inside its slot
                instead and the row stays one line; the pill's `aria-label`
                carries the full band either way, so nothing is lost that a
                screen reader was relying on. `e2e/viewport.spec.ts` forces
                the font-size up and asserts the row holds.
                Narrower below `sm` rather than absent (#988 fixes the WCAG
                1.4.1 regression #965/#960 shipped here — the word used to be
                `hidden` there, leaving the dot's colour as the only visible
                band signal on a phone screen, which is where the docked strip
                spends most of ITS life). Not `sm:w-28`: the full 112px slot
                measured too wide to add next to the score digits and the
                toggle group at 375-639px without growing the pre-existing
                #959 page-level horizontal-overflow finding (measured
                scrollWidth 435-442 vs clientWidth 375 at 375px — present
                whether or not this word renders, so not something this change
                added, but not something to make worse either).
                A first cut used `w-14` (56px, clearing "Strong" whole) — but
                that budget was derived only against the dimension-tile group
                (`hidden` below `lg`, so weightless at 375px), not against Fix
                It (#810), which has no width gate and renders at every width
                when there is guidance. `expectDockedStripIsOneLine` caught it
                in all three `MOBILE_REGIMES` fixtures: the Fix It button needs
                73–75px at 375px, and `w-14` left only 44px of the row for it.
                `w-5` (20px) is the number instead — chosen for margin, not for
                an exact fit: measured 5–8px of slack across those three
                regimes once group 2 is Fix It, real headroom against the two
                budgets (group 2's content, and the #959 overflow ceiling
                above) moving again. It truncates "Strong" too now, not just
                the two longer labels — still a distinct, visible, per-band
                text string, so colour is no longer the sole carrier at any
                width; the pill's `aria-label` carries the untruncated band
                regardless. Re-measure both this and the Fix It button's width
                (`FixItButton.tsx`) together before changing either — they
                share this one row's budget at 375-639px. */}
            <span
              className={`inline-block w-5 truncate text-center text-2xs font-semibold uppercase tracking-wider sm:w-28 ${scoreBandTextClass(tier)}`}
            >
              {tierLabel}
            </span>
          </span>
        </Button>
      </div>

      {/* Fix It takes the tiles' slot when there is guidance (#810). The
          docked strip is the state nearly every user acts from — the widget
          docks itself ~4.5s after arrival — so an entry that lived only in
          the expanded readout was one click behind the page's main job. It
          REPLACES the tiles rather than joining them: the tiles alone need
          486–496px of a fixed 545–549px budget (group comment below), so no
          button fits beside them without clipping a tile. The trade is sound
          on its merits too — the tiles are three numbers that link into the
          résumé, Fix It is the ordered walk through what those numbers are
          missing, and the numbers stay one click away behind
          `Score details ▾`. With no guidance the tiles come back.

          Unlike the tiles, this group has no `lg`+ gate, so it also renders
          at 375px — where it shares the row with group 1's verdict-word slot
          (see the comment on that span) rather than with the tiles, which
          are weightless there. A slot sized only against the tiles' absence
          below `lg` clipped this group instead; re-measure both together.

          No `overflow-hidden` here, unlike the tile group: it would clip the
          button's `focus-visible` ring, which is drawn outside its box.
          `expectDockedStripIsOneLine` asserts this group's `scrollWidth <=
          clientWidth` across the same regime × width matrix all the same. */}
      {/* All three tiles whole, or none — never a tile cut in half.
          #960's first attempt made this group `min-w-0 overflow-hidden` and
          called it "the one thing allowed to shrink or clip". That traded the
          wrap for a PERMANENT truncation: the group was never given enough
          width at any viewport, so the third tile rendered as
          `COMPLETENESS ▬▬▬ 2` with its `27/30` sliced through, and the clipped
          `<a>` stayed focusable — half-hidden content a keyboard user can land
          on (WCAG 2.4.11). This group's width budget is FIXED, not a function
          of the viewport, which is why no breakpoint alone could have fixed it:

            budget = container − group 1 − group 3 − two `gap-3` gaps

          and the page container tops out at 934px, so from `lg` (1024px) up the
          budget is a flat 545–549px (it varies only with group 1's score
          digits) no matter how wide the screen gets. Measured against that:
          the tiles needed 580–589px as they shipped, hence the clip in every
          regime at every width. `w-6` tracks (see `CompactDimension`) and no
          inter-tile `·` separators bring them to 486–496px — a ≥50px (≥9%)
          margin in the worst of the six `SCORE_REGIMES`. That margin is NOT
          for cross-OS font variance — Poppins is self-hosted via
          `@fontsource/poppins`, so glyph metrics are identical on ubuntu and
          macOS. It is headroom for a copy or padding change: the tile labels
          and the score digits both feed this budget, and `scrollWidth <=
          clientWidth` flips straight from fine to clipped with no warning
          band, because this group takes its content width and any spare goes
          to the row's trailing `ml-auto` (#680), never into this group.

          Revealed at `lg`, not `md`: at 768px the budget is only 289–293px,
          which fits no whole set of these tiles. Below `lg` the group is
          `display:none` — genuinely absent, so its anchors leave the tab order
          too — and the dimension detail is one tap away behind
          `Score details ▾`, which is visible at every width.

          `min-w-0 overflow-hidden` is kept as containment of last resort so a
          future overrun can never push group 3 off the row or reopen #959's
          horizontal-page-overflow finding. It must never actually engage:
          `expectDockedStripIsOneLine` (`e2e/support/score-hero.ts`) asserts
          `scrollWidth <= clientWidth` on this group across the full regime ×
          width matrix, which is what keeps the budget above honest. */}
      {fixIt ? (
        <div className="flex min-w-0 items-center">
          {fixIt}
        </div>
      ) : (
        <div className="hidden min-w-0 items-center gap-2 overflow-hidden text-xs text-content-secondary lg:flex">
          <CompactDimension
            label="Specificity"
            value={score.specificity.score}
            max={score.specificity.max}
            gradable={score.specificity.gradable}
            anchor="#reconstructed-resume"
          />
          <CompactDimension
            label="Structure"
            value={score.structure.score}
            max={score.structure.max}
            gradable={score.structure.gradable}
            anchor="#reconstructed-resume"
          />
          <CompactDimension
            label="Completeness"
            value={score.completeness.score}
            max={score.completeness.max}
            gradable={score.completeness.gradable}
            anchor="#contact"
          />
        </div>
      )}

      {/* `ml-auto` (#680) is what pins this group to the right edge now that
          the row is no longer `justify-between` — see the row comment above. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
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
          {/* Below `sm`, with Fix It in the row, the words go and the chevron
              stays: at 375px the pill, `ⓘ` and `Score details ▾` leave the
              Fix It slot ~15px against the ~71px its button needs. The
              accessible name is `EXPAND_LABEL` at every width, and the score
              pill beside it is a second, labelled route to the same state. */}
          <span className={fixIt ? "hidden sm:inline" : undefined}>
            Score details
          </span>{" "}
          ▾
        </Button>
      </div>
    </div>
  );
}

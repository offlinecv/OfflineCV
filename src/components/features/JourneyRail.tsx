// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JourneyRail — the L1 arc in the page header, and the guidance card a stage
 * with nothing behind it shows instead (issue #812).
 *
 * Reuse analysis (CLAUDE.md's Reuse Gate). `shared/Stepper.tsx` was the
 * candidate and is genuinely a different concern, not a second copy of this.
 * `Stepper` is PANEL-OWNING: `StepperContext` hands `StepPanel` and
 * `StepperNav` the current step, and every panel it toggles must sit inside the
 * same React tree as the rail that toggles them. This arc spans two separate
 * HTML entries (`/` and `/jobs/`) joined by `location.href` navigations and two
 * sessionStorage handoffs — there is no shared tree for panels to live in, and
 * three of the five stages resolve to a tab inside another component's state
 * rather than to a panel at all. `Stepper` also GATES nothing but presents a
 * sequence terminating in one commit action; this rail deliberately gates
 * nothing and terminates in nothing. Extending `Stepper` to serve both would
 * mean making its panels optional, its context optional, and its ownership of
 * the current step optional — i.e. deleting what makes it a stepper.
 *
 * What this file does NOT own: where the rail sits (`PageShell`), what a stage
 * click does (each surface — see `App.tsx` / `jobs/JobsApp.tsx`), and the
 * derivation itself (`lib/journey.ts`). Everything here is a pure function of
 * props, derived during render — no effects, deliberately. The `/jobs/` → `/`
 * return leg is a bfcache restore that never remounts the tree, so any state
 * this component computed in a mount-only `useEffect(…, [])` would be frozen at
 * whatever it was before the trip (the #783 defect).
 *
 * Accessibility. There is no ARIA `stepper` role; the established pattern for
 * an ordered progress trail is a `<nav>` + ordered list whose current item
 * carries `aria-current="step"` — the same shape `Stepper.tsx`'s rail renders.
 * Position is stated in WORDS for a screen reader ("Step 2 of 5: Fix it.
 * Current step.") rather than left to the visual numerals, and the visible
 * number / mark / label are all `aria-hidden` so the sentence is announced
 * once, not three times. Position is counted over the stages actually RENDERED
 * (`journey.stages`), never over the full five — `Tailor` is absent from the
 * rail on a cold `/`, and "Step 4 of 5" announced over a four-entry list is a
 * miscount the listener cannot correct.
 *
 * State is never carried by colour. Each of the three states has its own disc
 * SHAPE and its own GLYPH — filled + numeral (current), ringed + ✓ (ready),
 * hairline + numeral (upcoming) — layered on the surface/weight step #516 asks
 * for, so the rail resolves in a greyscale render and for a user who cannot
 * separate the accent hue from the track. Upcoming text stays
 * `content-secondary`; `content-tertiary` and `content-muted` land at 4.04:1
 * against the recessed track in dark mode, under WCAG 1.4.3's 4.5:1 (see
 * `Stepper.tsx`). A READY stage is `content-primary` rather than
 * `content-secondary`: it is the likeliest next click, and sharing the
 * upcoming weight made the two indistinguishable.
 *
 * Touch targets. `min-h-11` / `min-w-11` (44×44 CSS px) on the triggers is the
 * VISIBLE box, and it is not redundant with `Button`'s `after:` overlay — that
 * overlay is a fixed 24×24 SC 2.5.8 floor and governs a different box (see
 * `Button.tsx`'s docblock).
 */

import { Button, Card } from "@design-system";
import {
  journeyStage,
  type Journey,
  type JourneyStage,
  type JourneyStageId,
} from "../../lib/journey.ts";

export interface JourneyRailProps {
  journey: Journey;
  /** Fires for every stage click. The caller decides whether that means "go
   *  there" or "explain what is missing" — see `isStageReachable`. */
  onStageClick: (id: JourneyStageId) => void;
}

export function JourneyRail({ journey, onStageClick }: JourneyRailProps) {
  return (
    <nav aria-label="Your job search, step by step" className="min-w-0">
      {/* The track is recessed (`bg-surface-subtle`) and the current stage sits
          on `bg-surface-card` — the #516 selection affordance `Tabs` and
          `Stepper` both use. Never `overflow-x-auto`: a rail that scrolls
          sideways hides the very thing it exists to show. Fitting the stages
          into a 320px viewport without either is the `<li>` sizing below.

          `gap-2` (8px), not the `gap-0.5` this first shipped with: these are
          adjacent 44px touch targets, and the 8px minimum spacing between them
          is a rule in its own right — a 2px gutter makes a mis-tap land on the
          neighbouring stage rather than on nothing. */}
      <ol className="flex items-stretch gap-2 rounded-md border border-border-light bg-surface-subtle p-1">
        {journey.stages.map((stage, index) => (
          <JourneyRailStage
            key={stage.id}
            stage={stage}
            index={index}
            total={journey.stages.length}
            isCurrent={stage.id === journey.current}
            hasData={journey.availability[stage.id]}
            onClick={() => onStageClick(stage.id)}
          />
        ))}
      </ol>
    </nav>
  );
}

function JourneyRailStage({
  stage,
  index,
  total,
  isCurrent,
  hasData,
  onClick,
}: {
  stage: JourneyStage;
  index: number;
  total: number;
  isCurrent: boolean;
  hasData: boolean;
  onClick: () => void;
}) {
  // Three states, three words. "Ready" rather than "Done": availability means
  // the stage has what it needs, which is not the same as the user having been
  // there — this rail keeps no completion ledger, on purpose.
  const state = isCurrent ? "Current step" : hasData ? "Ready" : "Not ready yet";

  // The state marker, and the reason this reads as a journey rather than as a
  // second tab bar. Each state gets a distinct SHAPE and a distinct GLYPH, not
  // a colour: filled disc + numeral (current), ringed disc + ✓ (ready), hairline
  // disc + numeral (upcoming). Greyscale-safe by construction, which is what
  // #516 asks for — and it survives the two failure modes a flat numeral had,
  // where the rail was indistinguishable from `Tabs` and the inactive entries
  // were grey text on a grey track.
  const marker = isCurrent
    ? "bg-accent-primary text-content-inverse"
    : hasData
      ? "border-2 border-accent-primary text-accent-primary"
      : "border border-border-strong text-content-secondary";

  return (
    // Two sizings, expressed as grow/basis rather than `flex-1`/`shrink-0` so
    // the breakpoints actually override each other (Tailwind emits
    // `flex-shrink` after the `flex` shorthand, so a `shrink-0` would silently
    // outrank a later `sm:flex-1`'s shrink half).
    //   < sm — non-current chips sit at their 44px touch-target floor and drop
    //          their labels to the marker alone; the current one takes every
    //          remaining pixel, so the rail fits a 320px viewport with no wrap
    //          and no h-scroll.
    //   sm+  — the rail always owns a full row of its own, so equal columns are
    //          safe at every width above `sm` and there is no third band. The
    //          `lg:` content-sizing this carried before existed only for the
    //          in-header-row placement that #812 dropped.
    <li
      className={
        isCurrent
          ? "min-w-0 grow basis-0"
          : "min-w-0 grow-0 basis-11 sm:grow sm:basis-0"
      }
    >
      <Button
        variant="tab"
        aria-current={isCurrent ? "step" : undefined}
        onClick={onClick}
        className={[
          "min-h-11 w-full min-w-11 gap-2 px-2 sm:px-3",
          isCurrent
            ? "bg-surface-card font-semibold text-content-primary shadow-xs ring-1 ring-inset ring-border-light"
            : hasData
              ? // A ready stage earns `content-primary`: it has data behind it,
                // it is the likeliest next click, and at `content-secondary` it
                // was visually identical to a stage the user cannot use yet.
                "bg-transparent font-medium text-content-primary hover:bg-surface-hover"
              : "bg-transparent font-normal text-content-secondary hover:bg-surface-hover hover:text-content-primary",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold leading-none tabular-nums",
            marker,
          ].join(" ")}
        >
          {/* U+2713 + U+FE0E (VS-15) forces TEXT presentation, so the mark
              renders monochrome in `currentColor` rather than as a colour
              pictograph from the OS emoji font (design-system/CLAUDE.md). */}
          {!isCurrent && hasData ? "✓︎" : index + 1}
        </span>
        <span
          aria-hidden="true"
          className={isCurrent ? "truncate" : "hidden truncate sm:inline"}
        >
          {stage.label}
        </span>
        <span className="sr-only">
          Step {index + 1} of {total}: {stage.label}. {state}.
        </span>
      </Button>
    </li>
  );
}

export interface JourneyGuidanceProps {
  /** The stage the user asked for that has nothing behind it yet. Only a stage
   *  with an `empty` state ever reaches here — the first stage has none. */
  stage: JourneyStage;
  /** Send the user to the prerequisite the guidance names. */
  onGoToPrerequisite: (id: JourneyStageId) => void;
  onDismiss: () => void;
}

/**
 * The empty state a rail — as opposed to a wizard — owes the user: the click
 * was allowed, so something has to answer it. Rendered as the first content
 * block under the header, not as a lock on the trigger.
 */
export function JourneyGuidance({
  stage,
  onGoToPrerequisite,
  onDismiss,
}: JourneyGuidanceProps) {
  const empty = stage.empty;
  if (empty === null) return null;
  const prerequisite = journeyStage(empty.prerequisite);

  return (
    <Card className="shadow-xs">
      {/* Announced rather than silently swapped in: the trigger that opened
          this card is up in the header, so a screen-reader user who activated
          it gets no other signal that anything happened. The live region is
          the inner wrapper because `Card` owns only chrome (same shape
          `Result.tsx`'s verdict block uses). */}
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-content-primary">
          {stage.label}
        </h2>
        <p className="max-w-prose text-sm text-content-secondary">
          {empty.guidance}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="md"
            onClick={() => onGoToPrerequisite(prerequisite.id)}
          >
            Go to {prerequisite.label}
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Card>
  );
}

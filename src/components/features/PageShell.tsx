// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PageShell — the chrome all root surfaces share (issue #226, #707).
 *
 * `/` (parser audit, App.tsx) and `/jobs` (JobsApp.tsx) are two products
 * under one brand, so the header (logo + "Saved jobs" link + GitHub-star
 * CTA + update banner) and the footer (privacy line + links) are identical
 * between them. This shell owns that chrome once; each surface passes its
 * own `subtitle`, `badge`, optional `chips`, and an optional `headerExtra`
 * slot (e.g. a "back" cross-link CTA), then renders its body as `children`.
 *
 * The "Saved jobs" link (#707) is the one entry point into `/jobs/` that
 * doesn't depend on a parse — `FindJobsLauncher` only renders once a résumé
 * is parsed. It's a plain `<a href>`, not a `Button`, matching the wordmark
 * link and the footer links above/below it: this is real navigation (right-
 * click / open-in-new-tab should work), not an imperative action. `JobsApp`
 * passes `hideSavedJobsLink`: a link to `/jobs/` rendered on `/jobs/` itself
 * would point at the page already open.
 *
 * What the link must do BEFORE it navigates differs per surface — `/` has a
 * parse to hand over and a departure to mark (#706), any non-root surface
 * has neither — and this shell cannot know which surface it is rendering on.
 * So it owns none of that: it invokes an optional `onSavedJobsNavigate` and
 * the surface decides. Calling `markDeparture()` from here instead was a real
 * bug — the marker means "this trip started at the app root", and shared
 * chrome renders everywhere.
 *
 * The journey rail (#812) arrives the same way: the shell PLACES it — on its
 * own full-width row at every width, and its guidance card as the first content
 * block under the header — and owns nothing else about it. The surface derives
 * the stages (`deriveJourney`) and decides what a click does; the ask-and-route
 * state in between is `useJourneyGuidance`, which is where the render-time
 * derivation of the blocked stage is documented.
 *
 * Reuse: consumes only `@design-system` primitives/shared components, the
 * `JourneyRail` sibling, and the useGitHubStars / useUpdateChecker /
 * useJourneyGuidance hooks. No raw <button> / hardcoded palette.
 */

import { useState, type MouseEvent, type ReactNode } from "react";
import { UpdateBanner, GitHubStarCta } from "@design-system";
import { useGitHubStars } from "../../hooks/useGitHubStars.ts";
import { useUpdateChecker } from "../../hooks/useUpdateChecker.ts";
import {
  useJourneyGuidance,
  type JourneyNavigation,
} from "../../hooks/useJourneyGuidance.ts";
import { savedJobsHref } from "../../lib/jobs-landing.ts";
import { JourneyRail, JourneyGuidance } from "./JourneyRail.tsx";

/** The rail contract, owned by `useJourneyGuidance` — aliased here because it
 *  is also this component's prop shape. */
export type PageShellJourney = JourneyNavigation;

export interface PageShellProps {
  /**
   * Optional subtitle shown beside the GitHub-star CTA on wide viewports.
   *
   * Optional because a surface that already states what it is in its own body
   * should not restate it here. `/jobs` opens straight into a form, so the
   * header line is its only orientation and it passes one; `/` opens with a
   * headline two inches below the header and omits it, which also lets the
   * star CTA sit alone on the header-right instead of sharing it with a
   * competing tagline.
   */
  subtitle?: string;
  /** Small uppercase badge after the wordmark (e.g. "alpha", "JD Fit"). */
  badge: string;
  /** Optional block rendered under the header (e.g. the capability strip). */
  chips?: ReactNode;
  /** Optional header-right slot rendered before the GitHub CTA. */
  headerExtra?: ReactNode;
  /**
   * Suppress the "Saved jobs" link (#707). Only `JobsApp` sets this — a link
   * to `/jobs/` on `/jobs/` itself would point at the page already open.
   */
  hideSavedJobsLink?: boolean;
  /**
   * Ran just before the browser follows the "Saved jobs" link, for whatever
   * this surface must do on its way out (`/` writes the jobs handoff and marks
   * the departure — see `jobs-departure.ts`; a non-root surface passes
   * nothing). Fires only on an unmodified primary click, i.e. only when THIS
   * document is the one navigating.
   */
  onSavedJobsNavigate?: () => void;
  /**
   * The top-level journey rail (#812). Omitted → no rail, and the header keeps
   * its pre-#812 single-row shape. Supplied → the rail renders on its own
   * full-width row below the brand row at every width.
   */
  journey?: PageShellJourney;
  children: ReactNode;
}

export function PageShell({
  subtitle,
  badge,
  chips,
  headerExtra,
  hideSavedJobsLink,
  onSavedJobsNavigate,
  journey,
  children,
}: PageShellProps) {
  const { count: starCount } = useGitHubStars();

  // Proactive stale-deploy notice (see useUpdateChecker). Dismissable so a user
  // mid-analysis can defer; the vite:preloadError backstop still catches a hard
  // chunk failure if they ignore it.
  const { updateAvailable, reload } = useUpdateChecker();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Which stage the user asked for that has nothing behind it yet, and where a
  // click goes. Derived during render inside the hook — see its docblock.
  const { blockedStage, onStageClick, dismiss } = useJourneyGuidance(journey);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 pb-10">
      {updateAvailable && !updateDismissed && (
        <UpdateBanner
          onReload={reload}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      {/* Sticky so the rail is a permanent orientation signal rather than
          something you scroll away from. `-mx-6 px-6` bleeds the backdrop over
          `main`'s own gutters (without it the blurred band stops short of the
          page edge and content shows through beside it), and `main` dropped its
          top padding so the bar sits flush from the first paint — a sticky
          element keeps its space in flow, so there is no layout shift when it
          pins, but a gap above it would show unstyled content sliding past.
          One rail node, not one per breakpoint, and it is a SIBLING of the
          brand row rather than a wrap-item inside it: now that it always takes
          a row of its own, living in the wrap row bought nothing and cost it
          the row's tight `gap-y-2`, which left the track visually welded to the
          brand. As a sibling it gets the header column's own gap instead.

          THIS BAND'S HEIGHT IS A DEPENDENCY. `styles.css` sets a
          `scroll-padding-top` on the scrolling root sized to the measured
          maximum of this header, so that every in-page scroll target — the
          score tiles' `#contact` / `#reconstructed-resume` hash anchors, and
          the `scrollIntoView({ block: "start" })` calls in
          `ReconstructedResume` and `JobSearchResults` — lands below it rather
          than underneath it. Anything that adds a row here (a `headerExtra`,
          a longer CTA, a taller rail) has to be re-measured there. */}
      <header className="sticky top-0 z-20 -mx-6 flex flex-col gap-4 border-b border-border-light bg-surface-base/95 px-6 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* No `shrink-0` on either of the two header-row blocks: the row is
              `flex-wrap`, and a block that cannot shrink wraps instead — which
              at 320px turned the brand and the CTAs into two rows of their own.
              They keep the pre-#812 behaviour of compressing to fit. */}
          <div className="flex items-center gap-2">
            <a
              href={import.meta.env.BASE_URL}
              className="inline-grid h-8 w-8 place-items-center rounded-md bg-accent-primary text-base font-bold text-content-inverse"
              aria-label="offlinecv home"
            >
              O
            </a>
            <h1 className="text-2xl font-semibold tracking-tight">offlinecv</h1>
            <span className="text-3xs font-semibold uppercase tracking-wider text-content-muted">
              {badge}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-4">
            {!hideSavedJobsLink && (
              <a
                href={savedJobsHref()}
                onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                  // A ⌘/ctrl/shift/alt-click, or a non-primary button, opens
                  // the link somewhere else (new tab, new window, download)
                  // and leaves THIS document exactly where it is — but it
                  // still dispatches an ordinary `click`, unlike middle-click's
                  // `auxclick`. Running the callback then would decouple its
                  // side effects (a departure marker, a handoff write) from any
                  // navigation at all. Never `preventDefault` — the browser
                  // must still follow the link in every case.
                  if (
                    e.button !== 0 ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey
                  ) {
                    return;
                  }
                  onSavedJobsNavigate?.();
                }}
                className="text-sm text-content-secondary transition-colors hover:text-content-primary"
              >
                Saved jobs
              </a>
            )}
            {headerExtra}
            {subtitle && (
              <p className="hidden text-sm text-content-muted sm:block">
                {subtitle}
              </p>
            )}
            <GitHubStarCta variant="inline" count={starCount} />
          </div>
        </div>
        {journey && (
          // Its OWN full-width row at every width — never folded into the brand
          // row, even where the horizontal space exists. Sharing that row made
          // the rail read as one more header control sitting beside "Saved
          // jobs" and the star CTA, which is precisely the L1-vs-L2 confusion
          // #812 exists to remove; and it forced a third content-sized
          // breakpoint band whose chips were sized by the narrowest share left
          // after the brand and the CTAs took theirs. A dedicated row costs one
          // line of vertical space and gives the arc a register of its own.
          <div className="w-full min-w-0">
            <JourneyRail journey={journey.state} onStageClick={onStageClick} />
          </div>
        )}
        {chips && <div className="w-full">{chips}</div>}
      </header>

      {blockedStage && (
        // First content block, OUTSIDE the sticky header: a card pinned to the
        // top of the viewport would eat the screen it is trying to send the
        // user back across.
        <JourneyGuidance
          stage={blockedStage}
          onGoToPrerequisite={onStageClick}
          onDismiss={dismiss}
        />
      )}

      {children}

      <footer className="mt-auto flex flex-col items-center gap-2 border-t border-border-light pt-6 text-center text-sm text-content-tertiary">
        {/* No prose line here. The privacy sentence that used to sit above
            these links ("Your PDF stays in this browser tab by default…") was
            a claim compressed to the point where it could not carry its own
            caveats — the honest version needs the itemised egress list, so it
            lives on /privacy/, one link away, instead of being asserted in
            passing on every screen. */}
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          {/* Same-tab, base-aware links to the static content pages under
              public/. They are the only pages on this site a crawler can read
              without executing the bundle (every app entry renders into an
              empty #root), so this footer is also what keeps them from being
              orphaned — a page nothing links to is a page nothing finds.
              "Privacy & data" now lands on /privacy/, which summarises the
              README's telemetry section and links onward to it. */}
          <a href={`${import.meta.env.BASE_URL}how-it-works/`} className="hover:underline">
            How it works
          </a>
          <a href={`${import.meta.env.BASE_URL}faq/`} className="hover:underline">
            FAQ
          </a>
          <a href={`${import.meta.env.BASE_URL}privacy/`} className="hover:underline">
            Privacy &amp; data
          </a>
          <a href={`${import.meta.env.BASE_URL}open-source/`} className="hover:underline">
            Open source
          </a>
          <a
            href="https://github.com/offlinecv/OfflineCV/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            License
          </a>
        </div>
      </footer>
    </main>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one definition of "leave `/` for `/jobs/`".
 *
 * There are two routes off the parser-audit surface into the job workbench: the
 * journey rail's Match-jobs stage (#812) and the "Saved jobs" link `PageShell`
 * puts in the header on every surface (#707). A third — the Find Jobs tab's
 * `FindJobsLauncher` — was a second door onto the same corridor and went with
 * the tab rail in #823. Both survivors must do exactly the same two things
 * before the browser navigates, and when they diverged the header link shipped
 * a route that defeated the other: the library on `/jobs/` reads its résumé
 * from the sessionStorage handoff, so a user who parsed on `/` and arrived via
 * the header link got no fitness ratings at all, plus a "open this workbench
 * from your resume" hint — shown to someone who had just done that. Composing
 * the two writes here means a fourth route cannot re-introduce that split by
 * forgetting one of them.
 *
 * What this unifies is the MECHANICS of leaving. The PAYLOAD is unified
 * elsewhere and separately: both callers now read `App`'s `useLlmRecovery`, so
 * a user who repaired a degenerate parse with the on-device pass departs with
 * the RECOVERED fields rather than the ones the parser got wrong (#823).
 *
 * It is deliberately NOT the navigation itself: the rail's stage assigns
 * `location.href` while the header link is a real `<a href>` the browser
 * follows (so open-in-new-tab works), and folding the navigation in would
 * force one of them to fake the other.
 *
 * `parsed` is optional because the header link exists on `/` before any parse —
 * that is the whole point of it — and there is simply nothing to hand over
 * then. The departure marker is written either way: the trip really did start
 * at the root, and `/jobs/`'s back control is right to return there. "Nothing
 * to hand over" is itself a write, though: the handoff key is deliberately not
 * one-shot (see `jobs-handoff.ts`), so skipping it silently would leave a
 * PREVIOUS launch's résumé in place — the user parses, visits `/jobs/`, comes
 * back, resets, and the header link then ranks the library against the résumé
 * they just discarded, with the "open this workbench from your resume" hint
 * suppressed because a handoff exists. Departing with no parse clears.
 */

import type { HeuristicParsedResume } from "./heuristics/types.ts";
import { writeJobsHandoff, clearJobsHandoff } from "./jobs-handoff.ts";
import { markDeparture } from "./nav-return.ts";

/**
 * Hand the current parse to `/jobs/` — or explicitly hand over nothing — and
 * record that this trip started at the app root. Call immediately before
 * navigating; safe to call from `/` only — `markDeparture` reads the current
 * path, and only a marker written at the root reads back as one.
 */
export function departToJobs(
  parsed?: HeuristicParsedResume,
  /** The journey-ledger key of the résumé being handed over (#826) — see
   *  `JobsHandoff.journeyKey` for why it travels rather than being re-derived
   *  on arrival. Omitted when there is no parse to carry it. */
  journeyKey?: string,
): void {
  if (parsed !== undefined) writeJobsHandoff({ parsed, journeyKey });
  else clearJobsHandoff();
  markDeparture();
}

/**
 * Depart AND navigate, for the routes that move the document themselves.
 *
 * One of the two routes off `/` is a button rather than a link — the journey
 * rail's Match-jobs stage (#812) — and it must assign a BASE-aware URL or the
 * `/OfflineCV/` Pages-fallback deploy 404s. That is a second thing a new route
 * can forget, so it joins the first here; the function stays even at one caller
 * because "leave, and leave base-aware" is the pair a future button will
 * otherwise re-derive. The header's "Saved jobs" entry stays a real `<a href>`
 * (open-in-new-tab must work) and calls {@link departToJobs} alone — which is
 * why the navigation is not folded into that function itself.
 */
export function departToJobsAndNavigate(
  parsed?: HeuristicParsedResume,
  journeyKey?: string,
): void {
  departToJobs(parsed, journeyKey);
  window.location.href = `${import.meta.env.BASE_URL}jobs/`;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one definition of "leave `/` for `/jobs/`".
 *
 * There are two routes off the parser-audit surface into the job workbench:
 * `FindJobsLauncher`'s button (rendered only once a résumé is parsed) and the
 * "Saved jobs" link `PageShell` puts in the header on every surface (#707).
 * Both must do exactly the same two things before the browser navigates, and
 * when they diverged the second one shipped a route that defeated the first:
 * the library on `/jobs/` reads its résumé from the sessionStorage handoff, so
 * a user who parsed on `/` and arrived via the header link got no fitness
 * ratings at all, plus a "open this workbench from your resume" hint — shown to
 * someone who had just done that. Composing the two writes here means a third
 * route cannot re-introduce that split by forgetting one of them.
 *
 * It is deliberately NOT the navigation itself: the launcher assigns
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
export function departToJobs(parsed?: HeuristicParsedResume): void {
  if (parsed !== undefined) writeJobsHandoff({ parsed });
  else clearJobsHandoff();
  markDeparture();
}

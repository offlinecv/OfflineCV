// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The one definition of "leave `/` for `/download/`" — the Download
 * counterpart to `jobs-departure.ts`.
 *
 * #1181 wires the journey rail's `Download` stage to `departToDownloadAndNavigate`
 * rather than opening `ExportDialog` in place. Composing the handoff write and
 * the departure marker here, the way `jobs-departure.ts` does for `/jobs/`,
 * means a future second route onto `/download/` cannot reintroduce the split
 * `jobs-departure.ts`'s docblock describes: a route that navigates but forgets
 * to hand the résumé over.
 *
 * Unlike `departToJobs`, there is no "leave with nothing" case: `/download/`
 * only has a reason to exist once a résumé is in hand (the rail's `Download`
 * stage is unavailable before then, same as `Match jobs`), so the handoff
 * payload is not optional here the way `JobsHandoff.parsed` is.
 */

import type { DownloadHandoff } from "./download-handoff.ts";
import { writeDownloadHandoff } from "./download-handoff.ts";
import { markDeparture } from "./nav-return.ts";

/**
 * Hand the current, recovered parse to `/download/` and record that this trip
 * started at the app root. Call immediately before navigating; safe to call
 * from `/` only — see `markDeparture`.
 *
 * Returns whether the handoff write landed — see `writeDownloadHandoff`. The
 * departure marker is set only when it did: marking a departure that never
 * actually navigates (the write failed, so `departToDownloadAndNavigate`
 * below stays put) would record a round trip that didn't happen, misleading
 * a later, unrelated visit to `/download/` or `/jobs/` into reading it as
 * genuine.
 */
export function departToDownload(handoff: DownloadHandoff): boolean {
  if (!writeDownloadHandoff(handoff)) return false;
  markDeparture();
  return true;
}

/**
 * Depart AND navigate, for the journey rail's `Download` stage button (#1181).
 *
 * `loc` defaults to `window.location` and is injectable only so a test can
 * assert the call without jsdom attempting a real navigation — production
 * code never passes it. Base-aware (`import.meta.env.BASE_URL`), the same
 * pattern `departToJobsAndNavigate` uses, or the `/OfflineCV/` Pages-fallback
 * deploy 404s.
 *
 * Does not navigate when the handoff write failed (quota / private-mode /
 * disabled storage): `writeDownloadHandoff` has already cleared whatever was
 * under the key, so navigating anyway would land on `/download/`'s "no résumé
 * yet" state with no way back to try again except the header link — the user
 * is better served staying on `/` where the Download stage is still live.
 */
export function departToDownloadAndNavigate(
  handoff: DownloadHandoff,
  loc: Pick<Location, "assign"> = window.location,
): void {
  if (!departToDownload(handoff)) return;
  loc.assign(`${import.meta.env.BASE_URL}download/`);
}

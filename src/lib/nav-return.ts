// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * "Back to your resume" / "Parser audit" controls on `/jobs/` and `/jd-fit/`
 * (#706): make a real back navigation when one is available, so a completed
 * parse and its inline edits — which live only in React state, restored by
 * bfcache on a genuine back navigation (measured on #706) — survive the trip.
 * A plain `window.location.href = BASE_URL` always PUSHES a fresh `/`, which
 * boots to its idle state and loses both.
 *
 * There is no API to read the previous history entry's URL from JavaScript,
 * by design, so "is the previous entry the app root?" cannot be answered by
 * inspecting `history` itself. Candidates considered: `document.referrer`
 * (ambient, and clobbered by whichever page loaded most recently — not
 * necessarily via one of these controls) and `history.length` (also ambient,
 * and wrong the moment a user has other same-tab navigations queued up). Both
 * infer the trip happened; neither proves it.
 *
 * Instead the OUTBOUND leg leaves a marker: `App.tsx` (the `/` → `/jd-fit/`
 * link) and `jobs-departure.ts` (both `/` → `/jobs/` routes) call
 * `markDeparture()` right before they navigate. A back control here then
 * knows a round trip through an instrumented launch point actually happened,
 * rather than guessing from ambient state. The known gap: it only covers
 * navigations that went through those call sites. A bookmarked `/jobs/`
 * URL, a link opened in a new tab, or a manual reload of `/jobs/` never sets
 * the marker — and correctly falls back to a fresh `/` rather than firing
 * `history.back()` into someone else's history stack.
 *
 * The marker stores the path it was written FROM, not a bare `"1"`, and
 * `readDepartureMarker()` answers true only for the app root. That is what
 * makes the fallback the safe failure mode rather than merely the usual one:
 * a marker written from `/jd-fit/` (the shared `PageShell` header renders a
 * "Saved jobs" link on every surface) would otherwise send `/jobs/`'s "Back to
 * your resume" control back to `/jd-fit/` — a real page, but not the one the
 * label names — and would consume the marker `/`'s own leg wrote, re-arming
 * the very lost-parse bug this module exists to fix. Encoding the origin makes
 * "only `/` marks a departure" an invariant this module enforces instead of a
 * convention every future caller has to remember. With it, the failure mode is
 * one-directional again: a marker that fails to read as root costs a lost
 * parse (today's status quo), never a dead end or a foreign page.
 *
 * The other half of that guarantee lives at the call sites: a marker must only
 * be written when THIS document is actually leaving. `PageShell`'s link is an
 * `<a href>`, and a ⌘/ctrl/shift-click on one dispatches an ordinary `click`
 * (unlike middle-click's `auxclick`) while the browser opens a new tab and this
 * document stays put — so the callback that marks is guarded on the modifier
 * keys there, and this module never gets a marker decoupled from a navigation.
 *
 * sessionStorage, per the repo's `ocv_*` convention: per-tab, dies with the
 * tab, and (unlike `jobs-handoff.ts`) single-use — a marker answers only the
 * NEXT visit's question, so leaving it live would tell a later, unrelated
 * visit in the same tab (e.g. a reload after the back control already fired)
 * that it, too, arrived from `/`.
 *
 * "Visit", specifically — not "click". This module deliberately does NOT
 * export a combined read-and-clear that a click handler can call, because a
 * marker consumed at click time outlives the leg it was written for: `/` →
 * `/jd-fit/` writes a root marker, and if `/jd-fit/` never touches it, the
 * user's next hop (the shared header's "Saved jobs" link) lands on `/jobs/`
 * with `/`'s marker still live — so `/jobs/`'s "Back to your resume" fires
 * `history.back()` into `/jd-fit/`, a real page but not the one the label
 * names, AND swallows the marker, so `/jd-fit/`'s own back control then
 * pushes a fresh blank `/` and loses the parse. Both halves of the bug above,
 * through two clicks on visible chrome. So the read and the clear are
 * separate exports and the pairing lives in `useArrivedFromRoot`, which each
 * non-root surface calls once at mount: whichever surface the marker's leg
 * actually landed on absorbs it, and every later surface correctly finds
 * nothing.
 */

const NAV_RETURN_KEY = "ocv_nav_from_root";

/**
 * Is `path` the app root — the one origin a departure marker may claim?
 *
 * Base-aware (`import.meta.env.BASE_URL` is `/` on the custom domain and
 * `/OfflineCV/` on the Pages fallback), and accepts the explicit
 * `index.html` spelling of the same page, which a direct file-ish link or a
 * static host can produce. `/jobs/` and `/jd-fit/` are neither.
 */
export function isAppRoot(path: string): boolean {
  const base = import.meta.env.BASE_URL;
  return path === base || path === `${base}index.html`;
}

/**
 * Call immediately before navigating away from `/` toward `/jobs/` or
 * `/jd-fit/` — records WHERE the trip started, so a back control can tell a
 * genuine round trip from `/` apart from one that started somewhere else.
 *
 * The origin is read off an injected `Location`, defaulting to this document's,
 * rather than taken as a bare `string`: a string parameter is an escape hatch a
 * future production caller can use to forge `markDeparture("/")` from a
 * non-root surface, which silently defeats `isAppRoot` and re-arms exactly the
 * defect the encoded origin exists to prevent. A test still writes the losing
 * case by passing `{ pathname: "/jd-fit/" }`, the same injection shape
 * `returnToResumeRoot` takes for `history`/`location`.
 */
export function markDeparture(
  from: Pick<Location, "pathname"> = window.location,
): void {
  try {
    sessionStorage.setItem(NAV_RETURN_KEY, from.pathname);
  } catch {
    // Quota / private-mode / disabled storage — the back control falls back
    // to a fresh navigation, which is always correct, just not a true back.
  }
}

/**
 * Does a departure marker say this visit's trip started at the app root?
 *
 * Non-destructive on purpose — see the module docblock: the clear belongs to
 * the visit (`useArrivedFromRoot`, at mount), not to whoever asks. Keeping the
 * read pure is also what makes it safe inside a `useState` lazy initializer,
 * which React StrictMode double-invokes; a clearing initializer would return
 * `true` on the first pass and `false` on the second, and the second is the one
 * React keeps.
 *
 * Non-throwing: absent or inaccessible storage both read as "no marker", which
 * resolves to the safe fallback.
 */
export function readDepartureMarker(): boolean {
  try {
    const from = sessionStorage.getItem(NAV_RETURN_KEY);
    return from !== null && isAppRoot(from);
  } catch {
    return false;
  }
}

/**
 * Retire the marker for this visit. Clears unconditionally — a marker from a
 * NON-root path is single-use too, and leaving it behind would let it answer a
 * later, unrelated visit's question. Idempotent, so StrictMode's
 * setup→cleanup→setup effect replay costs nothing.
 */
export function clearDepartureMarker(): void {
  try {
    sessionStorage.removeItem(NAV_RETURN_KEY);
  } catch {
    // Inaccessible storage — nothing was readable either, so there is no
    // marker left to mislead a later visit.
  }
}

/**
 * The decision itself, factored out from the sessionStorage IO above so it is
 * unit-testable with a plain boolean — no jsdom, no storage — and so the
 * "no marker" branch (a direct `/jobs/` visit) is exercised as easily as the
 * round-trip one.
 */
export function shouldReturnViaHistory(markerPresent: boolean): boolean {
  return markerPresent;
}

/** Minimal shape `returnToResumeRoot` needs from `window`, so a test can pass
 *  a stub instead of relying on jsdom's unimplemented `location.href`
 *  navigation. */
export interface ReturnNavigable {
  history: Pick<History, "back">;
  location: Pick<Location, "href">;
}

/**
 * The composed control: `history.back()` when this visit's departure marker
 * said the tab actually came from `/`, else a fresh navigation to the app
 * root. Used by both `/jobs/`'s and `/jd-fit/`'s "back to resume" controls —
 * the target root is the same for both.
 *
 * `arrivedFromRoot` is a parameter rather than a storage read here because the
 * marker is consumed once at mount (`useArrivedFromRoot`), not per click — see
 * the module docblock for the two-hop bug that made click-time consumption
 * wrong.
 */
export function returnToResumeRoot(
  arrivedFromRoot: boolean,
  win: ReturnNavigable = window,
): void {
  if (shouldReturnViaHistory(arrivedFromRoot)) {
    win.history.back();
  } else {
    win.location.href = import.meta.env.BASE_URL;
  }
}

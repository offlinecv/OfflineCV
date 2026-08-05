// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Landing-tab routing for `/jobs/` (#707, #715): `PageShell`'s "Saved jobs"
 * link needs `JobsApp` to land on the Saved jobs tab instead of the Search
 * tab its `tab` state defaults to (`JobsApp.tsx`). A query param is the right
 * carrier for that in-app link — a plain `<a href>` full-document navigation,
 * not client-side routing, so there is no router state to thread through, and
 * unlike `nav-return.ts`'s sessionStorage marker (consumed on read, so a
 * reload or a pasted URL loses it) a param survives both a direct paste of
 * the URL and a reload, which #707's Done-when explicitly required.
 *
 * #715 adds a second, independent carrier: the literal `#saved` hash, for a
 * direct link handed out from OUTSIDE this app — e.g. the cover-letter skill
 * pointing a user at the job it just wrote a letter for. A real path segment
 * (`/jobs/saved`) needs the STATIC HOST to route an unmatched path to
 * `jobs/index.html`, and this app deliberately does not have that: Vite's
 * `appType: "mpa"` (see `vite.config.ts`) 404s an unmatched path honestly
 * instead of falling back to the wrong page, and the production Workers-
 * assets deploy's `not_found_handling` now serves `404.html` with a real 404
 * status for any unmatched request. (It previously said
 * `single-page-application`, which served the ROOT `/index.html` — the
 * parser-audit page, not this one. Either way the unmatched path does not
 * reach this surface; the newer setting just fails honestly instead of
 * silently rendering the wrong page.) A hash is never sent to the server, so
 * `/jobs/#saved` resolves identically in dev, GitHub Pages, and Workers
 * assets with no routing change anywhere.
 *
 * The decision (which tab a given URL lands on) is factored out from the
 * `window.location` IO so it is unit-testable with plain strings — same
 * shape as `nav-return.ts`'s `shouldReturnViaHistory`.
 */

export type JobsTabId = "search" | "library";

const TAB_PARAM = "tab";
const LIBRARY_VALUE = "library";
const SAVED_HASH = "saved";

/**
 * Is this the `#saved` fragment (#715)?
 *
 * Matched LENIENTLY, unlike the query param. A fragment is hand-typed, pasted
 * and re-typed far more than a param — it is the carrier a producer OUTSIDE
 * this app hands a human — so `#Saved` and a `#saved?x` / `#saved/1` tail that
 * some chat client or tracker appended must not silently miss and drop the
 * user on the wrong tab. The strict-equality version missed both.
 *
 * The tail is cut at the first `?`, `&` or `/` rather than ignored wholesale,
 * so `#savedjobs` (a different anchor that merely starts the same way) still
 * does NOT match — leniency about DECORATION, not about the name.
 */
function isSavedHash(hash: string): boolean {
  return hash.replace(/^#/, "").split(/[?&/]/)[0].toLowerCase() === SAVED_HASH;
}

/** Decide which `JobsApp` tab a `/jobs/` URL should land on, from its query
 *  string and hash. The `#saved` hash (#715) wins over the query param when
 *  both are somehow present — it is the more specific ask, a direct link to
 *  THIS tab, versus the query param's more general in-app carrier. Absent or
 *  any other value falls back to "search" — the same default a plain
 *  `/jobs/` visit gets today, so an old bookmark or a link from before either
 *  carrier existed is unaffected. */
export function resolveInitialJobsTab(search: string, hash: string = ""): JobsTabId {
  if (isSavedHash(hash)) return "library";
  return new URLSearchParams(search).get(TAB_PARAM) === LIBRARY_VALUE
    ? "library"
    : "search";
}

/** Base-aware URL to `/jobs/`, landing directly on Saved jobs — same
 *  `import.meta.env.BASE_URL` pattern as `FindJobsLauncher`'s navigation, so
 *  it resolves correctly under both the custom-domain `/` base and the
 *  `/OfflineCV/` Pages-fallback base. */
export function savedJobsHref(): string {
  return `${import.meta.env.BASE_URL}jobs/?${TAB_PARAM}=${LIBRARY_VALUE}`;
}

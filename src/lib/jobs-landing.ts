// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Landing-tab routing for `/jobs/` (#707): `PageShell`'s "Saved jobs" link
 * needs `JobsApp` to land on the Saved jobs tab instead of the Search tab its
 * `tab` state defaults to (`JobsApp.tsx`). A query param is the right carrier
 * — this is a plain `<a href>` full-document navigation, not client-side
 * routing, so there is no router state to thread through, and unlike
 * `nav-return.ts`'s sessionStorage marker (consumed on read, so a reload or a
 * pasted URL loses it) a param survives both a direct paste of the URL and a
 * reload, which the issue's Done-when explicitly requires.
 *
 * The decision (which tab a given URL lands on) is factored out from the
 * `window.location` IO so it is unit-testable with a plain string — same
 * shape as `nav-return.ts`'s `shouldReturnViaHistory`.
 */

export type JobsTabId = "search" | "library";

const TAB_PARAM = "tab";
const LIBRARY_VALUE = "library";

/** Decide which `JobsApp` tab a `/jobs/` URL should land on, from its query
 *  string. Absent or any other value falls back to "search" — the same
 *  default a plain `/jobs/` visit gets today, so an old bookmark or a link
 *  from before this param existed is unaffected. */
export function resolveInitialJobsTab(search: string): JobsTabId {
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

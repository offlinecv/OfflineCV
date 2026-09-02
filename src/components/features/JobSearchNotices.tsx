// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobSearchNotices — the "what the lane did to your result set, and how to undo
 * it" paragraph stack that sits above the ranked cards.
 *
 * Extracted out of `JobSearchResults`'s `Loaded` (#905 review): each of the
 * lane's three hard filters (#568 role, #563 exclude, #809 local-only) can be
 * SKIPPED by the never-fail-closed floor or can REMOVE postings, and every one
 * of those outcomes owes the user a sentence naming the control that caused it.
 * That is five branches of pure copy, which had grown `Loaded` into the largest
 * function in the file; none of it reads any of `Loaded`'s state.
 *
 * COPY RULE: name the control the way the control names ITSELF. The local-only
 * checkbox is `Only jobs near {location}` whenever a location is set — and it
 * cannot filter without one — so no notice here may quote the location-less
 * "only jobs near me" spelling; it refers to the filter by role instead ("the
 * local-only filter above"), which stays true whichever label is rendered.
 */

import type { JobSearchResult } from "../../lib/job-search/search.ts";

type NoticeFlags = Pick<
  JobSearchResult,
  | "degradedProviders"
  | "excludeSuppressed"
  | "roleSuppressed"
  | "locationSuppressed"
  | "locationFilteredOut"
>;

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-content-tertiary">{children}</p>;
}

export function JobSearchNotices({
  degradedProviders,
  excludeSuppressed,
  roleSuppressed,
  locationSuppressed,
  locationFilteredOut,
}: NoticeFlags) {
  return (
    <>
      {degradedProviders.length > 0 && (
        <Notice>
          Couldn&apos;t reach {degradedProviders.join(", ")} — showing results
          from the other feeds.
        </Notice>
      )}
      {excludeSuppressed && (
        <Notice>
          Your exclude terms would have removed every match, so we skipped them
          for this search — open Edit search to remove or narrow a term and
          apply exclusion again.
        </Notice>
      )}
      {roleSuppressed && (
        <Notice>
          Role filter skipped — it would have hidden every result, so we kept
          them all for this search. Open Edit search to adjust the Role chips
          and apply role filtering again.
        </Notice>
      )}
      {locationFilteredOut > 0 && (
        <Notice>
          {locationFilteredOut} posting{locationFilteredOut === 1 ? "" : "s"}{" "}
          hidden as too far away — untick the local-only filter above to see{" "}
          {locationFilteredOut === 1 ? "it" : "them"} again.
        </Notice>
      )}
      {/* Deliberately does NOT say the postings stated no location: the floor
       *  fires whenever the filter would empty a non-empty set, and the common
       *  cause is a set that stated locations, all elsewhere. */}
      {locationSuppressed && (
        <Notice>
          Local-only filter skipped — it would have hidden every result, so we
          kept them all for this search. Untick the local-only filter above, or
          try a broader location.
        </Notice>
      )}
    </>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Set operations on the raw-postings snapshot `searchJobs` returns.
 *
 * #568 let the refinement controls (role chips, level, excludes, comp floor,
 * location) re-rank a result set with no refetch, because all of them are pure
 * functions of a snapshot the last fetch already produced. The COMPANY selector
 * is different in kind: a company that wasn't selected at fetch time has no
 * postings in the snapshot at all, so no amount of local recomputation can
 * conjure them. That asymmetry is what these helpers exist to serve:
 *
 *  - **Removing** a company is pure snapshot arithmetic and free. A board
 *    posting's id is `{ats}:{slug}:{jobId}` (`company-boards.ts`), whose prefix
 *    is the same `{ats}:{slug}` string `companyKey()` builds — so its postings
 *    are identifiable without adding an attribution field to `JobPosting`.
 *  - **Adding** one needs that board fetched, and `mergeRawPostings` is where the
 *    result rejoins the snapshot under the SAME dedup rule the original fan-out
 *    used. Sharing `dedupKey` with `search.ts` is the point: a second dedup
 *    definition would let an incrementally-added board duplicate a posting the
 *    keyless feeds already carried.
 *
 * Leaf module — types only, no provider/rank imports — so a caller can hold the
 * snapshot logic without pulling the search tier into its chunk.
 */

import type { JobPosting } from "./types.ts";

/** Lowercased, whitespace-collapsed — so spacing differences between feeds
 *  don't read as two different postings. */
function normalizeField(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Cross-provider dedup key: normalized title + company. Each field is
 *  normalized independently, then joined, so a trailing space in one feed's
 *  title can't shift the boundary. */
export function dedupKey(posting: JobPosting): string {
  return `${normalizeField(posting.title)}::${normalizeField(posting.company)}`;
}

/**
 * `existing` plus every posting in `incoming` that isn't already present under
 * `dedupKey`. Existing postings win: they may have been hydrated (descriptions
 * filled in) and already carry a rank the user has seen, so replacing one with a
 * fresh-but-equivalent row would reshuffle the list for no gain.
 *
 * Order is append-only for the same reason — ranking happens downstream in
 * `refineSearchResult`, so this only has to be stable, not sorted.
 */
export function mergeRawPostings(
  existing: readonly JobPosting[],
  incoming: readonly JobPosting[],
): JobPosting[] {
  const seen = new Set(existing.map(dedupKey));
  const merged = [...existing];
  for (const posting of incoming) {
    const key = dedupKey(posting);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(posting);
  }
  return merged;
}

/**
 * `raw` without the postings that came from any of `companyKeys` (each an
 * `{ats}:{slug}` string from `companyKey()`).
 *
 * Matches on the `{key}:` prefix, not `startsWith(key)`, so `lever:acme` cannot
 * also strip `lever:acme-labs`. Keyless-feed postings are never touched: their
 * ids are prefixed with a feed slug (`remotive:…`), which no company key equals.
 *
 * One deliberate consequence: when a company board and a keyless feed both
 * carried the same posting, dedup kept whichever arrived first. If that was the
 * board's copy, deselecting the company drops the posting even though a feed also
 * had it. That is the honest reading of the action — the user said "don't show me
 * this company" — and re-selecting refetches, so nothing is lost permanently.
 */
export function dropCompanyPostings(
  raw: readonly JobPosting[],
  companyKeys: readonly string[],
): JobPosting[] {
  if (companyKeys.length === 0) return [...raw];
  const prefixes = companyKeys.map((key) => `${key}:`);
  return raw.filter(
    (posting) => !prefixes.some((prefix) => posting.id.startsWith(prefix)),
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * IndexedDB cache for company ATS boards (#533, slice 5 of epic #528).
 *
 * A company board has no server-side search, so every search pulls that
 * company's WHOLE light index. Re-opening the panel or tweaking a skill chip
 * would otherwise re-hit a dozen boards for bytes that barely change day to
 * day. This caches one board's light index under `${ats}:${slug}` with a
 * TTL, so a second search inside the window costs zero network.
 *
 * What is cached is the LIGHT INDEX ONLY — titles/locations/departments, with
 * `description: ""`. `writeCachedBoard` ENFORCES that: it strips every
 * description before persisting and caps the row count at `MAX_CACHED_POSTINGS`,
 * so the invariant holds regardless of what the adapter handed in. That matters
 * because it is NOT adapter-uniform: Greenhouse's light index already carries
 * `description: ""`, but Lever's response carries the real `descriptionPlain`,
 * so without the strip a cached Lever board would persist every full
 * description — the one field that dominates the cache's size. Descriptions are
 * re-hydrated per surviving posting downstream (see `company-boards.ts`):
 * Greenhouse and Lever both have a keyless per-job endpoint. Ashby has none, so
 * Ashby is never cached at all — its small, monolithic board is re-fetched
 * fresh each time, descriptions intact; that skip lives in `makeBoardProvider`.
 *
 * THE CACHE MAY NEVER SINK A SEARCH. Every failure mode here — IndexedDB
 * unavailable (private browsing, disabled storage), a blocked upgrade, an
 * expired row, a corrupt row written by an older build — resolves to "treat as
 * a miss" or "silently skip the write". Neither function rejects, so a caller
 * never needs a try/catch around them.
 */

import { getRecord, putRecord } from "../storage/crud.ts";
import type { BoardCacheRecord } from "../storage/types.ts";
import type { JobPosting } from "./types.ts";

/**
 * How long a cached board stays fresh. 12h sits inside the issue's 6–24h
 * band: job boards move on a scale of days, and a full day of staleness would
 * outlive a single job-hunting session, which is the unit a user would notice.
 */
export const BOARD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Hard cap on postings persisted per board. A light-index row (title, location,
 * departments, ids, timestamp — no description) is a few hundred bytes, so 300
 * rows stays comfortably under ~100 KB per board even for the largest
 * Greenhouse index, while still covering every board in the registry with room
 * to spare. The cap is a backstop against a pathologically huge board ballooning
 * IndexedDB, not a functional limit: the cache is an optimization, so anything
 * past the cap is simply re-fetched rather than served stale.
 */
export const MAX_CACHED_POSTINGS = 300;

/** Cache key. `ats` is in the key because the same slug can exist on two
 *  vendors and mean two different companies. */
export function boardCacheKey(ats: string, slug: string): string {
  return `${ats}:${slug}`;
}

/**
 * The cached light index for a board, or `null` on miss / expiry / any error.
 * `null` always means "go fetch" — it never distinguishes the reasons, because
 * no caller acts differently on them.
 */
export async function readCachedBoard(
  ats: string,
  slug: string,
): Promise<JobPosting[] | null> {
  try {
    const record = await getRecord<BoardCacheRecord>(
      "boards",
      boardCacheKey(ats, slug),
    );
    if (!record || !Array.isArray(record.postings)) return null;
    // `updatedAt` is stamped by putRecord on every write, so freshness tracks
    // the last fetch rather than when the row was first created. Guard the type
    // first: a corrupted/missing timestamp makes `Date.now() - x` NaN, and
    // `NaN > TTL` is `false` — which would treat an unbounded-age row as fresh.
    if (
      typeof record.updatedAt !== "number" ||
      Date.now() - record.updatedAt > BOARD_CACHE_TTL_MS
    )
      return null;
    return record.postings as JobPosting[];
  } catch {
    return null;
  }
}

/** Store a board's light index. Resolves even when the write fails — a cache
 *  that can't persist degrades to no cache, never to a failed search. */
export async function writeCachedBoard(
  ats: string,
  slug: string,
  postings: readonly JobPosting[],
): Promise<void> {
  try {
    // Enforce "light index only" at the write boundary, so no caller — and no
    // vendor whose adapter returns a full `descriptionPlain` (Lever) — can
    // sneak a heavy description into the cache. Cap first, then strip: even a
    // 1000-row board persists at most `MAX_CACHED_POSTINGS` description-less
    // rows. A survivor's description is re-hydrated on read downstream.
    const light: JobPosting[] = postings
      .slice(0, MAX_CACHED_POSTINGS)
      .map((p) => (p.description === "" ? p : { ...p, description: "" }));
    await putRecord<BoardCacheRecord>("boards", {
      id: boardCacheKey(ats, slug),
      postings: light,
    });
  } catch {
    // Intentionally swallowed — see the module docblock.
  }
}

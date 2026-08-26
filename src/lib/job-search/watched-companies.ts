// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * IndexedDB accessor for the persisted company watchlist (#864).
 *
 * Reaches `../storage/crud.ts` directly rather than routing through a
 * domain-agnostic `storage/watched.ts` module — mirroring `board-cache.ts`,
 * the one other job-search module that does this (see the exception note on
 * `storage/index.ts`'s barrel docblock). There is no such module because this
 * store has exactly one domain consumer (`useCompanyTargets`) and one bridge
 * reader (`watched-companies-bridge.ts`), both in this repo, unlike jobs and
 * letters, which are public producer contracts other repos write against.
 *
 * Key shape `${ats}:${slug}` — the same natural-key reasoning as
 * `boardCacheKey` in `board-cache.ts` and `companyKey` in
 * `useCompanyTargets.ts`: the same slug can exist on two vendors and mean two
 * different companies, and re-saving the same company is an upsert, not a
 * duplicate.
 */

import { getAllRecords, putRecord, deleteRecord } from "../storage/crud.ts";
import type { WatchedCompanyRecord } from "../storage/types.ts";
import type { Ats, CompanyEntry } from "./company-registry.ts";

export interface WatchedCompany {
  id: string;
  ats: Ats;
  slug: string;
  displayName: string;
  addedAt: number;
}

/** Natural key: same shape as `boardCacheKey`/`companyKey` elsewhere in this
 *  lane — not shared, by the same house convention those two follow. */
export function watchedCompanyKey(ats: Ats, slug: string): string {
  return `${ats}:${slug}`;
}

function toWatchedCompany(record: WatchedCompanyRecord): WatchedCompany {
  return {
    id: record.id,
    ats: record.ats as Ats,
    slug: record.slug,
    displayName: record.displayName,
    addedAt: record.createdAt,
  };
}

/** The whole saved shortlist, in no particular guaranteed order (small — a
 *  handful of rows — so callers that care about order sort it themselves). */
export async function getWatchedCompanies(): Promise<WatchedCompany[]> {
  const records = await getAllRecords<WatchedCompanyRecord>("watched");
  return records.map(toWatchedCompany);
}

/** Upsert one company onto the shortlist. Re-saving the same `ats`+`slug`
 *  updates the existing row (same `id`) rather than duplicating it. */
export async function saveWatchedCompany(entry: CompanyEntry): Promise<WatchedCompany> {
  const record = await putRecord<WatchedCompanyRecord>("watched", {
    id: watchedCompanyKey(entry.ats, entry.slug),
    ats: entry.ats,
    slug: entry.slug,
    displayName: entry.name,
  });
  return toWatchedCompany(record);
}

/** Remove one company from the shortlist. No-op (does not throw) if it
 *  wasn't there. */
export async function removeWatchedCompany(ats: Ats, slug: string): Promise<void> {
  await deleteRecord("watched", watchedCompanyKey(ats, slug));
}

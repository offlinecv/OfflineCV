// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Generic typed CRUD over one object store (#321). Both `resumes` and `jobs`
 * share this — one code path, no per-store duplication — with the store-specific
 * record shape supplied as the type parameter. `resumes.ts` / `jobs.ts` wrap
 * these with domain helpers (blob handling, id generation).
 */

import type { IDBPDatabase } from "idb";
import { getDB, UPDATED_AT_INDEX } from "./db.ts";
import type { StoreName, StoredRecord, SyncableStoreName } from "./types.ts";

/**
 * The store-typed `getDB()` keys `get`/`put` to a specific store's value type,
 * which a store-agnostic generic can't satisfy (the store name is only known at
 * runtime). These helpers operate through a loosely-typed handle on purpose;
 * the store-specific record type is reasserted via the `<T>` parameter, so
 * callers (`resumes.ts` / `jobs.ts`) still get a fully-typed surface.
 */
async function looseDB(): Promise<IDBPDatabase> {
  return (await getDB()) as unknown as IDBPDatabase;
}

/** Upsert a record, stamping timestamps from a single `now`: `createdAt` comes
 *  from the existing row (update), else the record's own value (import restore),
 *  else `now`; `updatedAt` is `now` unless the write opts out. A brand-new record
 *  therefore has `createdAt === updatedAt`. Domain helpers omit the timestamps and
 *  let this own them; import passes them through to preserve `createdAt`.
 *
 *  `touch: false` means *the record's own `updatedAt` is the truth* — for a write
 *  the USER did not make. Clearing a job's dangling resume link when that resume
 *  is deleted (#323) is the motivating case: stamping it would reshuffle a
 *  tracker sorted most-recently-updated-first, so deleting one resume makes every
 *  job that merely referenced it jump to the top. Never use it for a user edit.
 *
 *  The record's own value is preferred over the stored one, and the order
 *  matters (#730). Those housekeeping callers spread the existing record, so for
 *  them the two are the same value and nothing changes. The caller that needs
 *  this precedence is `importAll`: a restored record carries the `updatedAt` it
 *  had when the backup was taken, and that timestamp is a fact about the user's
 *  edit, not about the restore. Stamping `now` over it — which is what this did
 *  before the option existed here — scrambled a whole library into one
 *  indistinguishable instant, losing the tracker's ordering, and now also tells
 *  a replicator that every record on the device changed at once. Only a record
 *  with no timestamp at all falls through to `now`, which is the fresh-capture
 *  case (`captureJob` strips both stamps deliberately). */
export async function putRecord<T extends StoredRecord>(
  store: StoreName,
  record: Omit<T, "createdAt" | "updatedAt"> &
    Partial<Pick<T, "createdAt" | "updatedAt">>,
  options: { touch?: boolean } = {},
): Promise<T> {
  const db = await looseDB();
  const now = Date.now();
  const existing = (await db.get(store, record.id)) as T | undefined;
  const written = {
    ...record,
    createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt:
      options.touch === false
        ? (record.updatedAt ?? existing?.updatedAt ?? now)
        : now,
  } as T;
  await db.put(store, written);
  return written;
}

export async function getRecord<T extends StoredRecord>(
  store: StoreName,
  id: string,
): Promise<T | undefined> {
  const db = await looseDB();
  return (await db.get(store, id)) as T | undefined;
}

/**
 * Every record in a store — **excluding tombstones by default** (#730).
 *
 * The default is the safe direction, and it is chosen rather than inherited: a
 * caller that forgets the option shows the user live records, and a caller that
 * wants deleted ones has to name that intent. The alternative default would
 * make every existing list surface silently start rendering deleted rows,
 * which is the failure `deletedAt` exists to prevent.
 *
 * `includeDeleted` has exactly two legitimate users, both of which need to see
 * a deletion *as a fact* rather than as an absence: the export document (see
 * `backup.ts`, which explains why a backup carries tombstones) and replication.
 */
export async function getAllRecords<T extends StoredRecord>(
  store: StoreName,
  options: { includeDeleted?: boolean } = {},
): Promise<T[]> {
  const db = await looseDB();
  const all = (await db.getAll(store)) as T[];
  return options.includeDeleted === true ? all : all.filter(isLive);
}

/** True for a record no delete has touched. One definition, so no caller
 *  invents `deletedAt === 0` or a falsy check — `0` is a real epoch-ms value
 *  and only ABSENCE means live. */
export function isLive(record: StoredRecord): boolean {
  return record.deletedAt === undefined;
}

/**
 * Records whose `updatedAt` is strictly greater than `since`, read through the
 * v4 index rather than by scanning the store (#730).
 *
 * **Tombstones are included**, and that is the whole point: a deletion this
 * device has not replicated yet is a change, and the query that finds unpushed
 * changes has to return it. It is the mirror image of {@link getAllRecords}'s
 * default, for the mirror-image caller.
 *
 * Strictly greater, so passing back the last record's own `updatedAt` as the
 * next cursor cannot loop on it forever. Ordered by the index key — oldest
 * first — which is also the order a replicator must write in, so an interrupted
 * pass can advance its cursor to the last record it actually wrote.
 *
 * Nothing in this build calls it; the browser extension does, across the pin.
 * The same staging `capture.ts` documents, for the same reason: this repo owns
 * the schema, so the query that reads the index belongs beside the migration
 * that creates it rather than being re-derived against a store the caller does
 * not own.
 */
export async function listRecordsUpdatedSince<T extends StoredRecord>(
  store: SyncableStoreName,
  since: number,
): Promise<T[]> {
  const db = await looseDB();
  return (await db.getAllFromIndex(
    store,
    UPDATED_AT_INDEX,
    IDBKeyRange.lowerBound(since, true),
  )) as T[];
}

/**
 * Tombstone a record: stamp `deletedAt` and leave the row in place. Returns
 * false when there was nothing to delete or it was already deleted, so a repeat
 * call is a no-op rather than a second deletion with a newer timestamp.
 *
 * **`updatedAt` moves too**, and it has to. A replicator finds unpushed work
 * with {@link listRecordsUpdatedSince}; a tombstone that kept the record's old
 * `updatedAt` would sit below every cursor that had already passed it and would
 * never be pushed at all — the deletion would be invisible to every other
 * holder of the library, which is exactly the state tombstones exist to avoid.
 * This is also why it does not take `putRecord`'s `touch: false`: a deletion is
 * a user action, and floating it to the top of a most-recently-updated-first
 * list is correct — the row is about to stop being rendered anyway.
 */
export async function softDeleteRecord(
  store: StoreName,
  id: string,
): Promise<boolean> {
  const db = await looseDB();
  const existing = (await db.get(store, id)) as StoredRecord | undefined;
  if (existing === undefined || !isLive(existing)) return false;
  const now = Date.now();
  await db.put(store, { ...existing, deletedAt: now, updatedAt: now });
  return true;
}

/**
 * Remove a record outright, tombstone and all.
 *
 * Still the right delete for `resumes` and `boards` — see the per-store note on
 * `StoredRecord.deletedAt`. For a replicating store this is a PURGE, not a
 * delete: it destroys the evidence a second holder needs, so the next pull
 * resurrects the record. Reach for {@link softDeleteRecord} there.
 */
export async function deleteRecord(
  store: StoreName,
  id: string,
): Promise<void> {
  const db = await looseDB();
  await db.delete(store, id);
}

/** Wipe every record from a store. Used by import (replace mode) and tests. */
export async function clearStore(store: StoreName): Promise<void> {
  const db = await looseDB();
  await db.clear(store);
}

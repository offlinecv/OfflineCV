// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Generic typed CRUD over one object store (#321). Both `resumes` and `jobs`
 * share this — one code path, no per-store duplication — with the store-specific
 * record shape supplied as the type parameter. `resumes.ts` / `jobs.ts` wrap
 * these with domain helpers (blob handling, id generation).
 */

import type { IDBPDatabase } from "idb";
import { getDB } from "./db.ts";
import type { StoreName, StoredRecord } from "./types.ts";

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
 *  `touch: false` keeps the existing `updatedAt` — for a write the USER did not
 *  make. Clearing a job's dangling resume link when that resume is deleted (#323)
 *  is the motivating case: stamping it would reshuffle a tracker sorted
 *  most-recently-updated-first, so deleting one resume makes every job that
 *  merely referenced it jump to the top. Never use it for a user edit. */
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
        ? (existing?.updatedAt ?? record.updatedAt ?? now)
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

export async function getAllRecords<T extends StoredRecord>(
  store: StoreName,
): Promise<T[]> {
  const db = await looseDB();
  return (await db.getAll(store)) as T[];
}

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

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
import { postLibraryChange } from "./library-channel.ts";
import type { StoreName, StoredRecord, SyncableStoreName } from "./types.ts";

/**
 * Emit-side coalescing scope for a bulk write (#760). While at least one scope
 * is open, a write records which store it touched instead of posting a change
 * signal immediately; one message per touched store goes out when the LAST
 * open scope closes, regardless of how many writes happened inside.
 *
 * This exists for `importAll` in `backup.ts` and `archiveJobs` in `jobs.ts`
 * (#759) — both per-record write loops that would otherwise post one message
 * per record and drive one full re-read per message in every other open tab;
 * the acceptance bar is a bounded message count for a bulk write, not a
 * debounce on the receiving side (see `backup.ts` for the reasoning).
 *
 * Deliberately not exported past this directory (not part of the barrel in
 * `index.ts`): an outside producer — the browser extension — writes through
 * `putRecord` directly and gets the unbatched, per-call behaviour, which is
 * correct for it too. It isn't running a bulk loop like the two callers
 * above, so there is nothing here for it to opt into. A future bulk write
 * from OUTSIDE `src/lib/storage/` belongs beside these two — as a named
 * primitive in its own store module — rather than as a barrel export of this
 * seam itself.
 */
const batchedStores = new Set<StoreName>();

/**
 * How many `runBatchedWrites` scopes are open right now.
 *
 * A COUNT rather than a nullable "am I the outermost call" flag, and the
 * difference is the whole correctness of this seam. A flag only distinguishes
 * genuine call-stack nesting; two independent calls whose lifetimes merely
 * OVERLAP — each `await`ing its own row loop, interleaved by the event loop —
 * both look outermost to a flag, so whichever finished first would close the
 * scope and every subsequent write of the still-running call would fall
 * through to the unbatched branch and post one message per record again. That
 * is the exact defect #760's bounded-message-count bar exists to prevent,
 * reached by two concurrent bulk writers instead of one looping caller.
 */
let openScopes = 0;

/**
 * Run `write` with change signals coalesced — see the module note above.
 *
 * Safe under BOTH shapes a second call can take:
 *
 *  - **Nested** (a batched caller calling another batched function) — the
 *    inner scope's close leaves the count above zero, so it posts nothing and
 *    the outer close carries its stores out.
 *  - **Concurrent** (two independent calls overlapping in time) — the same
 *    arithmetic covers it, because the count does not care which call is
 *    which. Both calls' touched stores accumulate into one set and flush
 *    together when the LATER one closes.
 *
 * That second case defers the earlier call's signal until the later call
 * finishes, which is more coalescing than a per-call scope would do, and is
 * sound because of what the message is: `library-channel.ts` carries only a
 * store name and means "re-read this store" — never "here is what changed",
 * and never an ordering token. Delivering one signal after both writers are
 * done therefore makes every subscriber read the state that includes both,
 * which is strictly fresher than what an earlier flush could have shown. The
 * delay is bounded by the longer of the two operations, which the subscriber
 * would have waited out anyway; and the tab that made the writes does not
 * depend on the message at all (it refreshes directly, and the channel
 * self-excludes — see `library-channel.ts`).
 *
 * The decrement is in a `finally` and precedes the flush, so a write that
 * THROWS cannot leave the count above zero and wedge every later emit into a
 * scope that never closes. The stores accumulated before the throw are still
 * flushed on the way out, which is correct: writes that did land are changes
 * other tabs must be told about, whether or not the caller finished.
 */
export async function runBatchedWrites<T>(write: () => Promise<T>): Promise<T> {
  openScopes += 1;
  try {
    return await write();
  } finally {
    openScopes -= 1;
    if (openScopes === 0) {
      // Snapshot and clear BEFORE posting: `postLibraryChange` is synchronous
      // and re-entrant in principle, and a listener that wrote back into the
      // set being iterated would otherwise lose or re-post a store.
      const touched = [...batchedStores];
      batchedStores.clear();
      for (const store of touched) postLibraryChange(store);
    }
  }
}

/** Post now, or record for the open `runBatchedWrites` scopes to flush. */
function emitChange(store: StoreName): void {
  if (openScopes > 0) batchedStores.add(store);
  else postLibraryChange(store);
}

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
  emitChange(store);
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
 *
 * Emits a change signal (#760) on the same footing as `putRecord` — a
 * tombstone is a write through this same funnel, and skipping it would leave
 * a deleted job or letter visible in every other open tab. Only when the
 * tombstone is actually written; the early `return false` above is a no-op
 * and posts nothing, matching "a read posts none".
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
  emitChange(store);
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
  emitChange(store);
}

/** Wipe every record from a store. Used by import (replace mode) and tests. */
export async function clearStore(store: StoreName): Promise<void> {
  const db = await looseDB();
  await db.clear(store);
  emitChange(store);
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The `sync` store's accessor (#730) — one bookmark record per syncable store,
 * read and written by whatever is replicating this library.
 *
 * Two functions rather than a slot in the generic CRUD, because a
 * {@link SyncCursorRecord} is not a {@link StoredRecord}: it has no `createdAt`
 * worth keeping and no `updatedAt` anything sorts on, and it must never be
 * tombstoned. Routing it through `putRecord` would stamp a bookmark with
 * timestamps that describe the bookmark rather than anything the user has, and
 * would make it eligible for a soft delete that means nothing.
 *
 * **A cursor is a local fact, not a record.** It says what THIS device has
 * already exchanged, so it never rides through the export document — restoring
 * a backup onto a second device must not convince that device it has already
 * pulled everything. `backup.ts` carries no `sync` key for the same reason it
 * carries no `boards` key.
 *
 * Nothing in this build calls either function. Like `capture.ts` and
 * `listRecordsUpdatedSince`, the reader is the browser extension, which builds
 * these modules from a pinned commit of this repo and so cannot add an object
 * store of its own — the schema is this repo's to own, and an accessor that
 * lives anywhere else is a second definition of the record shape.
 */

import { getDB } from "./db.ts";
import type { SyncableStoreName, SyncCursorRecord } from "./types.ts";

/**
 * The bookmarks for one store, or undefined when that store has never been
 * replicated on this device.
 *
 * Undefined is deliberately not flattened into an empty record: "never pulled"
 * and "pulled, found nothing" are different states, and only the first one
 * licenses a full initial sync.
 */
export async function getSyncCursor(
  store: SyncableStoreName,
): Promise<SyncCursorRecord | undefined> {
  const db = await getDB();
  return db.get("sync", store);
}

/**
 * Merge a partial cursor update over whatever is stored, and return the result.
 *
 * Merged rather than replaced because the two cursors advance on their own
 * schedule — a pull that lands must not clear the push bookmark, and a push
 * that lands must not clear the pull bookmark. A caller that spread the record
 * itself would race the other direction on the read.
 *
 * The caller advances a cursor only AFTER the records it covers are written.
 * The reverse order is the one unrecoverable ordering here: a cursor written
 * first and then an interrupted write leaves a gap no later pass will look in
 * again, and nothing reports it.
 */
export async function setSyncCursor(
  store: SyncableStoreName,
  patch: Omit<Partial<SyncCursorRecord>, "id">,
): Promise<SyncCursorRecord> {
  const db = await getDB();
  const existing = await db.get("sync", store);
  const written: SyncCursorRecord = { ...existing, ...patch, id: store };
  await db.put("sync", written);
  return written;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * IndexedDB handle for the local-first storage foundation (#321).
 *
 * One database, five object stores (`resumes`, `jobs`, `boards`, `letters` and
 * the `sync` bookmarks that describe three of them), opened through the ~1KB
 * `idb` wrapper. Schema versioning lives here from day one: every future store
 * or index is a `DB_VERSION` bump with a matching branch in `upgrade()`, so an
 * existing user's data migrates forward instead of stranding. `upgrade()` runs
 * for the range `(oldVersion, DB_VERSION]`, so guarding each step with
 * `oldVersion < N` makes the migrations cumulative and idempotent.
 *
 * localStorage stays the home for the `ocv_*` UI flags (see README) — this module
 * is for structured/binary data only.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ResumeRecord,
  JobRecord,
  BoardCacheRecord,
  LetterRecord,
  SyncCursorRecord,
} from "./types.ts";

// Renamed from "resumelint" during the OfflineCV rename (#498). Safe to change
// outright: the store had no external users at cutover, so there was no data to
// strand. Treat it as frozen from here — a later rename WOULD orphan real users'
// resumes/jobs, because a different database name is a different database, not a
// `DB_VERSION` migration.
export const DB_NAME = "offlinecv";
/** Bump when adding/altering a store or index; add a matching `oldVersion < N`
 *  branch in `upgrade()`. Internal — only `getDB()` below reads it. Kept
 *  private deliberately: the migration tests assert against the OPEN database's
 *  own `db.version`, which is the thing a user's browser actually sees. A test
 *  that read this constant would compare the code to itself and pass even if
 *  `upgrade()` never ran.
 *
 *  ⚠️ A bump is a BREAKING change for the browser extension, which builds this
 *  module from a pinned commit of this repo (`extension/offlinecv-pin.json`)
 *  and reaches `getDB()` from a content script in the app's own origin — so it
 *  carries whatever version the pin had. Once the app has upgraded a user's
 *  database, an extension built at the older pin opens it at the lower version
 *  and gets a `VersionError`, breaking its captures. Bump the pin in lockstep
 *  and rebuild it; this repo's CI never compiles the extension, so nothing else
 *  will catch it. */
const DB_VERSION = 4;

/** Index name shared by every syncable store — one string so a range query and
 *  the three `createIndex` calls cannot drift apart. */
export const UPDATED_AT_INDEX = "updatedAt";

interface OfflineCvDB extends DBSchema {
  resumes: { key: string; value: ResumeRecord; indexes: { updatedAt: number } };
  jobs: { key: string; value: JobRecord; indexes: { updatedAt: number } };
  boards: { key: string; value: BoardCacheRecord };
  letters: { key: string; value: LetterRecord; indexes: { updatedAt: number } };
  sync: { key: string; value: SyncCursorRecord };
}

let dbPromise: Promise<IDBPDatabase<OfflineCvDB>> | null = null;

/** Open (once) and return the shared DB handle. Cached so concurrent callers
 *  share one connection. */
export function getDB(): Promise<IDBPDatabase<OfflineCvDB>> {
  if (dbPromise === null) {
    dbPromise = openDB<OfflineCvDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        // v0 → v1: both stores keyed on `id`. Keep future migrations as
        // additional `if (oldVersion < N)` blocks below — never edit an
        // already-shipped block.
        if (oldVersion < 1) {
          db.createObjectStore("resumes", { keyPath: "id" });
          db.createObjectStore("jobs", { keyPath: "id" });
        }
        // v1 → v2 (#533): the company-ATS-board cache. Purely additive — an
        // existing user's resumes/jobs are untouched, and the new store simply
        // starts empty (a cache miss, which the caller already handles).
        if (oldVersion < 2) {
          db.createObjectStore("boards", { keyPath: "id" });
        }
        // v2 → v3 (#711): cover letters, one record per draft. Additive in the
        // same way `boards` was — an existing profile's resumes and jobs are
        // untouched and the new store simply starts empty, which is also the
        // correct reading of an older profile (it has no letters because the
        // build that wrote it could not make one).
        //
        // No index on `jobId`: `lettersForJob` filters in memory. An index is a
        // further schema migration, and the store holds a handful of records
        // per tracked job — buying an index before there is a surface that
        // reads letters at all would be pinning a schema on a guess.
        if (oldVersion < 3) {
          db.createObjectStore("letters", { keyPath: "id" });
        }
        // v3 → v4 (#730): the three things replication needs from the local
        // schema. Additive like every block above it — no record is rewritten,
        // no field is required, and a profile that never replicates is
        // indistinguishable from a v3 one.
        //
        //  1. An `updatedAt` index on each syncable store. Without it, "what
        //     changed since the last push" is a full scan of every record on
        //     every pass. Survivable at a few hundred jobs and wrong as a
        //     design — and unlike the `letters.jobId` index deferred at v3,
        //     this one has a caller by construction, since a cursor that
        //     cannot be queried efficiently is not a cursor.
        //
        //     Created here rather than at `createObjectStore` time so the three
        //     stores get identical treatment in one place; a fresh database
        //     runs blocks 1 and 3 first, so all three exist by now. The
        //     versionchange transaction is the only place an index can be
        //     added at all, which is why `upgrade` takes `tx`.
        //
        //  2. The `sync` store: one bookmark record per syncable store, keyed
        //     on the store name. See `SyncCursorRecord` for why the pull and
        //     push cursors are different types reading different clocks.
        //
        // The third thing — `StoredRecord.deletedAt` — needs no migration at
        // all. It is optional, and an existing record without it is already
        // correctly readable as "not deleted".
        if (oldVersion < 4) {
          for (const store of ["resumes", "jobs", "letters"] as const) {
            tx.objectStore(store).createIndex(UPDATED_AT_INDEX, "updatedAt");
          }
          db.createObjectStore("sync", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/** Close the open connection (if any) and drop the cached handle. Test-only
 *  seam — an open connection blocks `deleteDB`, so a suite that wipes the
 *  database between cases must close first, then reopen fresh. */
export async function closeDB(): Promise<void> {
  if (dbPromise !== null) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

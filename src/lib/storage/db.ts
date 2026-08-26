// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * IndexedDB handle for the local-first storage foundation (#321).
 *
 * One database, six object stores (`resumes`, `jobs`, `boards`, `letters`,
 * `watched` and the `sync` bookmarks that describe three of them), opened
 * through the ~1KB
 * `idb` wrapper. Schema versioning lives here from day one: every future store
 * or index is a `DB_VERSION` bump with a matching branch in `upgrade()`, so an
 * existing user's data migrates forward instead of stranding. `upgrade()` runs
 * for the range `(oldVersion, DB_VERSION]`, so guarding each step with
 * `oldVersion < N` makes the migrations cumulative and idempotent.
 *
 * localStorage stays the home for the `ocv_*` UI flags (see README) — this module
 * is for structured/binary data only.
 */

import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ResumeRecord,
  JobRecord,
  BoardCacheRecord,
  LetterRecord,
  SyncCursorRecord,
  WatchedCompanyRecord,
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
 *  ⚠️ When you bump this, bump `extension/offlinecv-pin.json` in lockstep and
 *  rebuild the extension: this repo's CI never compiles it, so nothing else
 *  will catch the drift. {@link getExistingDB} is the opener a content script
 *  should use — it never requests a version, so it cannot hang waiting on a
 *  stale, still-open app tab — but the extension's own barrel
 *  (`extension/src/offlinecv-core.ts`) still imports the `getDB()`-backed
 *  functions by relative path, so the pin is what keeps this constant and that
 *  build in step. */
const DB_VERSION = 5;

/** Index name shared by every syncable store — one string so a range query and
 *  the three `createIndex` calls cannot drift apart. */
export const UPDATED_AT_INDEX = "updatedAt";

interface OfflineCvDB extends DBSchema {
  resumes: { key: string; value: ResumeRecord; indexes: { updatedAt: number } };
  jobs: { key: string; value: JobRecord; indexes: { updatedAt: number } };
  boards: { key: string; value: BoardCacheRecord };
  letters: { key: string; value: LetterRecord; indexes: { updatedAt: number } };
  sync: { key: string; value: SyncCursorRecord };
  watched: { key: string; value: WatchedCompanyRecord };
}

let dbPromise: Promise<IDBPDatabase<OfflineCvDB>> | null = null;
let existingDbPromise: Promise<IDBPDatabase<OfflineCvDB>> | null = null;

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
        // v4 → v5 (#864): the persisted company-watchlist store. Additive like
        // every block above — an existing user's résumés/jobs/letters/sync state
        // is untouched, and this new store simply starts empty, which is the
        // correct reading of "never saved a shortlist". No index: `useCompanyTargets`
        // reads the whole (small) store on mount, same as `getAllLetters` does for
        // `letters` — see the `oldVersion < 3` note above for why an index isn't
        // worth it before a caller needs one.
        if (oldVersion < 5) {
          db.createObjectStore("watched", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Open the database AT WHATEVER VERSION IT ALREADY IS, requesting no upgrade.
 *
 * For a content script — the browser extension's bridge, injected into an
 * already-open `offlinecv.org` tab — this repo's own page script is what owns
 * this database's schema, and by the time a content script runs, that page has
 * already opened it (and migrated it, if a migration was due) for this
 * session. A content script that instead calls {@link getDB} asks for THIS
 * repo's pinned `DB_VERSION`, which can be ahead of what the page's own
 * (possibly older, un-reloaded) connection is holding open. IndexedDB then
 * needs that older connection to close before the upgrade transaction the
 * extension just requested can even start; if it does not close, the request
 * never resolves — the content script hangs, silently, mid-capture, with
 * nothing in the console to say why.
 *
 * `indexedDB.open(name)` with no version argument cannot trigger that: it
 * attaches to the database's current version, whatever that is, and never
 * asks for an upgrade.
 *
 * ## The one case a versionless open cannot serve, and why it falls back
 *
 * Called against a database that does not exist yet — a profile that has only
 * ever used the extension, never the app itself, or one whose site data was
 * cleared — a versionless open still CREATES one, at version 1 with none of
 * `upgrade()`'s object stores, because IndexedDB has no "version 0" to open
 * at. That handle is not a usable empty library: `db.get`/`db.put`/`db.getAll`
 * against a store name the database does not have throw `NotFoundError`
 * synchronously rather than answering `undefined`/`[]`, so a first capture on
 * such a profile would throw instead of writing.
 *
 * So this opener detects that shape — a database with zero object stores, which
 * only a versionless open of a nonexistent database can produce — and falls
 * back to {@link getDB}, which creates the real schema. Falling back is safe
 * here precisely because nothing exists yet: the hang this function avoids
 * needs an OLDER connection to still be open, and there can be no connection
 * to a database that was not there a moment ago.
 *
 * The stray v1 database is DELETED before the fallback rather than handed to
 * `getDB()` to upgrade. `upgrade()`'s first block is guarded `oldVersion < 1`,
 * so an open at v1 skips it and the `resumes`/`jobs` stores would never be
 * created — the fallback would hand back a handle as unusable as the one it
 * replaced. Deleting first makes `getDB()`'s open a true v0 → v4 migration.
 * Nothing is lost: the database being deleted is the store-less one this call
 * just created, and it can hold no records by construction.
 */
export function getExistingDB(): Promise<IDBPDatabase<OfflineCvDB>> {
  if (existingDbPromise === null) {
    existingDbPromise = openExisting();
  }
  return existingDbPromise;
}

async function openExisting(): Promise<IDBPDatabase<OfflineCvDB>> {
  const db = await openDB<OfflineCvDB>(DB_NAME);
  if (db.objectStoreNames.length > 0) return db;
  db.close();
  await deleteDB(DB_NAME);
  return getDB();
}

/** Close the open connection(s), if any, and drop the cached handle(s).
 *  Test-only seam — an open connection blocks `deleteDB`, so a suite that
 *  wipes the database between cases must close first, then reopen fresh.
 *
 *  Both handles are cleared BEFORE either is awaited, and awaited through
 *  `allSettled`, so one rejected opener cannot strand the other's connection
 *  open — which would defeat the one thing this function exists to guarantee.
 *  A rejected promise has no connection to close, and a settled rejection is
 *  the correct no-op for it. Note the two can resolve to the SAME handle when
 *  {@link getExistingDB} fell back to {@link getDB}; `close()` is idempotent. */
export async function closeDB(): Promise<void> {
  const open = [dbPromise, existingDbPromise];
  dbPromise = null;
  existingDbPromise = null;
  await Promise.allSettled(
    open.map(async (pending) => {
      (await pending)?.close();
    }),
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * IndexedDB handle for the local-first storage foundation (#321).
 *
 * One database, two object stores (`resumes`, `jobs`), opened through the ~1KB
 * `idb` wrapper. Schema versioning lives here from day one: every future store
 * or index is a `DB_VERSION` bump with a matching branch in `upgrade()`, so an
 * existing user's data migrates forward instead of stranding. `upgrade()` runs
 * for the range `(oldVersion, DB_VERSION]`, so guarding each step with
 * `oldVersion < N` makes the migrations cumulative and idempotent.
 *
 * localStorage stays the home for the `rl_*` UI flags (see README) — this module
 * is for structured/binary data only.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ResumeRecord, JobRecord } from "./types.ts";

// Kept as "resumelint" through the OfflineCV rename: this is the IndexedDB
// database name, not a brand string. Renaming it would orphan every existing
// user's locally stored resumes/jobs (no migration path). It is invisible to
// users, so it stays for data continuity.
export const DB_NAME = "resumelint";
/** Bump when adding/altering a store or index; add a matching `oldVersion < N`
 *  branch in `upgrade()`. */
export const DB_VERSION = 1;

interface OfflineCvDB extends DBSchema {
  resumes: { key: string; value: ResumeRecord };
  jobs: { key: string; value: JobRecord };
}

let dbPromise: Promise<IDBPDatabase<OfflineCvDB>> | null = null;

/** Open (once) and return the shared DB handle. Cached so concurrent callers
 *  share one connection. */
export function getDB(): Promise<IDBPDatabase<OfflineCvDB>> {
  if (dbPromise === null) {
    dbPromise = openDB<OfflineCvDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v0 → v1: both stores keyed on `id`. Keep future migrations as
        // additional `if (oldVersion < N)` blocks below — never edit an
        // already-shipped block.
        if (oldVersion < 1) {
          db.createObjectStore("resumes", { keyPath: "id" });
          db.createObjectStore("jobs", { keyPath: "id" });
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

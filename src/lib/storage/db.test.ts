// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * {@link getExistingDB} (#recruidea-extension "open database without version
 * parameters in content script to prevent upgrade hangs"): the content-script
 * opener must never request a version against a database that already exists,
 * so it can never trigger an upgrade transaction — and must still hand back a
 * USABLE handle when no database exists yet.
 *
 * Both halves are asserted against what a browser actually sees — `db.version`
 * and a real read/write through the store — rather than against `DB_VERSION`,
 * which would compare the code to itself, the trap `DB_VERSION`'s own docblock
 * warns about.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, closeDB, getDB, getExistingDB } from "./db.ts";
import { captureJobIntoExisting } from "./capture.ts";
import { getJobFromExisting } from "./jobs.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

describe("getExistingDB", () => {
  it("attaches to a database the app already migrated, without re-requesting a version", async () => {
    const app = await getDB();
    expect(app.version).toBe(4);
    expect([...app.objectStoreNames]).toContain("jobs");
    await closeDB();

    const contentScript = await getExistingDB();
    expect(contentScript.version).toBe(4);
    expect([...contentScript.objectStoreNames]).toEqual([
      ...app.objectStoreNames,
    ]);
  });

  it("falls back to the full schema when no database exists yet", async () => {
    // A profile that has only ever used the extension, never the app itself. A
    // bare versionless open would create an empty v1 with no object stores —
    // a handle whose every read and write throws NotFoundError. The fallback
    // deletes that stray database and reopens through getDB(), so the caller
    // gets the real schema. (Deleting matters: upgrade()'s first block is
    // guarded `oldVersion < 1`, so upgrading the stray v1 in place would skip
    // it and leave `resumes`/`jobs` uncreated.)
    const db = await getExistingDB();
    expect(db.version).toBe(4);
    expect([...db.objectStoreNames]).toContain("jobs");
    expect([...db.objectStoreNames]).toContain("resumes");
  });

  it("reads a missing record as undefined on a never-visited profile, rather than throwing", async () => {
    // The regression: `db.get` against a store the database does not have
    // throws a synchronous NotFoundError instead of resolving to undefined.
    await expect(getJobFromExisting("nope")).resolves.toBeUndefined();
  });

  it("captures a job on a never-visited profile", async () => {
    // End to end through the capture door — the surface the hang this family
    // exists to close sits on, and the one a first-time extension user hits
    // before ever opening the app.
    const result = await captureJobIntoExisting({
      url: "https://boards.greenhouse.io/acme/jobs/1",
      title: "Staff Engineer",
      company: "Acme",
      capturedAt: Date.now(),
      source: "greenhouse",
    });
    expect(result.ok).toBe(true);
  });

  it("never triggers upgrade() even when its own DB_VERSION is behind", async () => {
    // Simulates the actual hang scenario's *shape* (an already-open database
    // at a version other than DB_VERSION) without fake-indexeddb's inability
    // to model a real cross-connection `blocked` event: what matters is that
    // getExistingDB's request against an EXISTING database carries no version
    // at all, so it has nothing to negotiate and nothing to block on.
    const legacy = await openLegacyV1();
    expect(legacy.version).toBe(1);
    legacy.close();

    const contentScript = await getExistingDB();
    expect(contentScript.version).toBe(1);
    expect([...contentScript.objectStoreNames]).toEqual(["jobs"]);
  });
});

/** A v1 database with a store — what an older app build left behind. Opened
 *  directly rather than through `getDB()`, which would migrate it to 4. */
function openLegacyV1(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("jobs", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

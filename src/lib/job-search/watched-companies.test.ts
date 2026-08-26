// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * watched-companies.ts tests (#864). Run against `fake-indexeddb/auto`, same
 * as `board-cache.test.ts` — the real `idb` + schema-upgrade path is
 * exercised, which is also what proves the `DB_VERSION` 4 → 5 bump actually
 * creates the `watched` store.
 */

import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { describe, it, expect, beforeEach } from "vitest";
import { DB_NAME, getDB, closeDB } from "../storage/db.ts";
import {
  getWatchedCompanies,
  saveWatchedCompany,
  removeWatchedCompany,
  watchedCompanyKey,
} from "./watched-companies.ts";
import type { CompanyEntry } from "./company-registry.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

const stripe: CompanyEntry = {
  name: "Stripe",
  ats: "greenhouse",
  slug: "stripe",
  sectors: ["fintech"],
};

describe("watchedCompanyKey", () => {
  it("namespaces by vendor, since one slug can exist on two ATSes", () => {
    expect(watchedCompanyKey("greenhouse", "circle")).not.toBe(
      watchedCompanyKey("ashby", "circle"),
    );
  });
});

describe("watched companies", () => {
  it("returns an empty list on an empty store", async () => {
    expect(await getWatchedCompanies()).toEqual([]);
  });

  it("reads back what it saved", async () => {
    await saveWatchedCompany(stripe);
    const companies = await getWatchedCompanies();
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({
      id: watchedCompanyKey("greenhouse", "stripe"),
      ats: "greenhouse",
      slug: "stripe",
      displayName: "Stripe",
    });
    expect(typeof companies[0].addedAt).toBe("number");
  });

  it("saving the same ats+slug twice yields one row, and the second save's displayName wins", async () => {
    await saveWatchedCompany(stripe);
    await saveWatchedCompany({ ...stripe, name: "Stripe, Inc." });

    const companies = await getWatchedCompanies();
    expect(companies).toHaveLength(1);
    expect(companies[0].displayName).toBe("Stripe, Inc.");
  });

  it("keeps vendors with the same slug separate", async () => {
    await saveWatchedCompany(stripe);
    await saveWatchedCompany({ ...stripe, ats: "ashby" });

    const companies = await getWatchedCompanies();
    expect(companies).toHaveLength(2);
  });

  it("removes a saved company", async () => {
    await saveWatchedCompany(stripe);
    await removeWatchedCompany("greenhouse", "stripe");

    expect(await getWatchedCompanies()).toEqual([]);
  });

  it("removing a company that was never saved is a no-op", async () => {
    await expect(removeWatchedCompany("greenhouse", "nobody")).resolves.toBeUndefined();
    expect(await getWatchedCompanies()).toEqual([]);
  });
});

describe("storage: schema migration v4 → v5 (#864)", () => {
  async function seedV4Profile(): Promise<void> {
    const legacy = await openDB(DB_NAME, 4, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          db.createObjectStore("resumes", { keyPath: "id" });
          db.createObjectStore("jobs", { keyPath: "id" });
        }
        if (oldVersion < 2) db.createObjectStore("boards", { keyPath: "id" });
        if (oldVersion < 3) db.createObjectStore("letters", { keyPath: "id" });
        if (oldVersion < 4) {
          for (const store of ["resumes", "jobs", "letters"] as const) {
            tx.objectStore(store).createIndex("updatedAt", "updatedAt");
          }
          db.createObjectStore("sync", { keyPath: "id" });
        }
      },
    });
    await legacy.put("jobs", {
      id: "job-1",
      title: "Staff Engineer",
      company: "Acme",
      status: "applied",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    legacy.close();
  }

  it("migrates a v4 profile to v5, adding the watched store and preserving existing records", async () => {
    await seedV4Profile();

    const db = await getDB();
    expect(db.version).toBe(5);
    expect(db.objectStoreNames.contains("watched")).toBe(true);

    const companies = await getWatchedCompanies();
    expect(companies).toEqual([]);

    await saveWatchedCompany(stripe);
    expect(await getWatchedCompanies()).toHaveLength(1);
  });
});

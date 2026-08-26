// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The v4 schema and the behaviour it buys (#730) — tombstones, the `updatedAt`
 * index, and the `sync` cursor store.
 *
 * Runs against `fake-indexeddb` like every other storage suite, so the real
 * `idb` upgrade path is exercised rather than mocked. The migration case seeds a
 * database by REPLAYING the shipped v3 upgrade blocks, not by calling `getDB()`
 * — a test that built the old profile with the new code would be asserting
 * against itself and would pass even if `upgrade()` never ran.
 */

import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, getDB, closeDB } from "./db.ts";
import {
  getRecord,
  getAllRecords,
  isLive,
  listRecordsUpdatedSince,
} from "./crud.ts";
import { getSyncCursor, setSyncCursor } from "./sync-cursor.ts";
import { saveJob, getJob, getAllJobs, deleteJob } from "./jobs.ts";
import {
  saveLetter,
  getLetter,
  getAllLetters,
  lettersForJob,
  deleteLetter,
} from "./letters.ts";
import { getAllResumes } from "./resumes.ts";
import { exportAll, importAll } from "./backup.ts";
import { captureJob } from "./capture.ts";
import { listJobs } from "../job-tracker.ts";
import { tick } from "./__test-utils__/clock.ts";
import type { JobRecord, LetterRecord } from "./types.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

const pdf = () => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
  type: "application/pdf",
});

const SEEDED_AT = 1_700_000_000_000;

describe("storage: schema migration v3 → v4 (#730)", () => {
  /** Recreate a database exactly as `DB_VERSION = 3` shipped it — the state a
   *  returning user's browser is holding. Replays the shipped upgrade blocks
   *  rather than asserting against them. */
  async function seedV3Profile(): Promise<void> {
    const legacy = await openDB(DB_NAME, 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("resumes", { keyPath: "id" });
          db.createObjectStore("jobs", { keyPath: "id" });
        }
        if (oldVersion < 2) db.createObjectStore("boards", { keyPath: "id" });
        if (oldVersion < 3) db.createObjectStore("letters", { keyPath: "id" });
      },
    });
    await legacy.put("resumes", {
      id: "resume-1",
      filename: "cv.pdf",
      blob: pdf(),
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    });
    await legacy.put("jobs", {
      id: "job-1",
      title: "Staff Engineer",
      company: "Northwind",
      status: "applied",
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    });
    await legacy.put("letters", {
      id: "letter-1",
      jobId: "job-1",
      body: "Dear Northwind,",
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    });
    legacy.close();
  }

  it("opens a v3 profile at v4 with resumes, jobs and letters intact", async () => {
    await seedV3Profile();

    const db = await getDB();
    // The OPEN database's version, not the module constant — see the note in
    // `db.ts` on why `DB_VERSION` is private. Pinned to the CURRENT
    // `DB_VERSION` (5 as of #864), not literally 4: `getDB()` always migrates
    // to whatever `DB_VERSION` is now, past v4 as later stores are added.
    expect(db.version).toBe(5);

    expect((await getAllResumes()).map((r) => r.filename)).toEqual(["cv.pdf"]);
    expect((await getAllJobs()).map((j) => j.title)).toEqual(["Staff Engineer"]);
    expect((await getAllLetters()).map((l) => l.body)).toEqual([
      "Dear Northwind,",
    ]);
  });

  it("adds the sync store and an updatedAt index on each syncable store", async () => {
    await seedV3Profile();

    const db = await getDB();
    expect(db.objectStoreNames.contains("sync")).toBe(true);
    const tx = db.transaction(["resumes", "jobs", "letters"]);
    for (const store of ["resumes", "jobs", "letters"] as const) {
      expect(Array.from(tx.objectStore(store).indexNames)).toContain(
        "updatedAt",
      );
    }
    // `boards` is a cache and does not replicate — no index, and no cursor.
    expect(Array.from(db.transaction("boards").objectStore("boards").indexNames))
      .toEqual([]);
  });

  it("indexes records that were written BEFORE the index existed", async () => {
    // The failure this guards: `createIndex` on a populated store backfills the
    // existing rows. A migration that only indexed future writes would leave a
    // returning user's whole library invisible to every range query, and every
    // other assertion in this file would still pass.
    await seedV3Profile();

    const migrated = await listRecordsUpdatedSince<JobRecord>("jobs", 0);
    expect(migrated.map((j) => j.id)).toEqual(["job-1"]);
  });

  it("upgrades a brand-new database straight to v4, indexes and all", async () => {
    // oldVersion 0 runs every block in one transaction, so block 4 creates its
    // indexes on stores blocks 1 and 3 made moments earlier.
    const db = await getDB();
    expect(db.version).toBe(5);
    expect(db.objectStoreNames.contains("sync")).toBe(true);
    expect(
      Array.from(db.transaction("jobs").objectStore("jobs").indexNames),
    ).toContain("updatedAt");
  });
});

describe("storage: tombstones (#730)", () => {
  async function seedJob(): Promise<JobRecord> {
    return saveJob({ title: "Staff Engineer", company: "Northwind", status: "applied" });
  }

  it("deleting a job hides it from every list surface but keeps the row", async () => {
    const job = await seedJob();
    await deleteJob(job.id);

    expect(await getAllJobs()).toEqual([]);
    expect(await listJobs()).toEqual([]);
    expect(await getJob(job.id)).toBeUndefined();

    // Still readable at the raw storage layer, which is what replication needs
    // and what nothing above `crud.ts` is given.
    const raw = await getRecord<JobRecord>("jobs", job.id);
    expect(raw?.id).toBe(job.id);
    expect(raw?.title).toBe("Staff Engineer");
    expect(typeof raw?.deletedAt).toBe("number");
    expect(isLive(raw!)).toBe(false);
  });

  it("stamps updatedAt on the tombstone, so a replicator can still find it", async () => {
    const job = await seedJob();
    await tick();
    await deleteJob(job.id);

    const raw = await getRecord<JobRecord>("jobs", job.id);
    // Without this the deletion sits below any cursor that already passed the
    // live record and would never be pushed anywhere.
    expect(raw!.updatedAt).toBeGreaterThan(job.updatedAt);
    expect(
      (await listRecordsUpdatedSince<JobRecord>("jobs", job.updatedAt)).map(
        (j) => j.id,
      ),
    ).toEqual([job.id]);
  });

  it("cascades to letters as tombstones of their own", async () => {
    const job = await seedJob();
    const letter = await saveLetter({ jobId: job.id, body: "Dear Northwind," });

    await deleteJob(job.id);

    expect(await getAllLetters()).toEqual([]);
    expect(await lettersForJob(job.id)).toEqual([]);
    expect(await getLetter(letter.id)).toBeUndefined();
    const raw = await getRecord<LetterRecord>("letters", letter.id);
    expect(typeof raw?.deletedAt).toBe("number");
  });

  it("is idempotent — a second delete does not re-stamp a newer deletedAt", async () => {
    const job = await seedJob();
    await saveLetter({ jobId: job.id, body: "Dear Northwind," });
    await deleteJob(job.id);
    const first = await getRecord<JobRecord>("jobs", job.id);

    await tick();
    await deleteJob(job.id);

    const second = await getRecord<JobRecord>("jobs", job.id);
    expect(second!.deletedAt).toBe(first!.deletedAt);
    expect(second!.updatedAt).toBe(first!.updatedAt);
    expect(await deleteLetter("nonexistent")).toBe(false);
  });

  it("refuses to edit a deleted job rather than resurrecting it", async () => {
    const { updateJob } = await import("../job-tracker.ts");
    const job = await seedJob();
    await deleteJob(job.id);

    await expect(updateJob(job.id, { title: "Back again" })).rejects.toThrow(
      /no job with id/,
    );
    expect(await getAllJobs()).toEqual([]);
  });

  it("but capturing the posting again revives it, as a hard delete always did", async () => {
    const job = await saveJob({
      title: "Staff Engineer",
      company: "Northwind",
      url: "https://boards.example.com/jobs/42",
      status: "applied",
    });
    await deleteJob(job.id);

    const result = await captureJob({
      title: "Staff Engineer",
      company: "Northwind",
      url: "https://boards.example.com/jobs/42",
    });

    expect(result.ok).toBe(true);
    expect((await getAllJobs()).map((j) => j.title)).toEqual(["Staff Engineer"]);
  });

  it("ignores a deletedAt a producer tried to send", async () => {
    // A capture says a posting exists. It is in no position to say the user
    // deleted their record of it, so the field is stripped before validation
    // rather than written and then filtered.
    const result = await captureJob({
      title: "Staff Engineer",
      url: "https://boards.example.com/jobs/43",
      deletedAt: 1_700_000_000_000,
    });

    expect(result.ok).toBe(true);
    const stored = await getRecord<JobRecord>(
      "jobs",
      result.ok ? result.record.id : "",
    );
    expect(stored?.deletedAt).toBeUndefined();
    expect(await getAllJobs()).toHaveLength(1);
  });
});

describe("storage: the updatedAt index (#730)", () => {
  it("returns only records strictly newer than the cursor, oldest first", async () => {
    const first = await saveJob({ title: "First", status: "interested" });
    await tick();
    await saveJob({ title: "Second", status: "interested" });
    await tick();
    const third = await saveJob({ title: "Third", status: "interested" });

    expect(
      (await listRecordsUpdatedSince<JobRecord>("jobs", 0)).map((j) => j.title),
    ).toEqual(["First", "Second", "Third"]);

    // Strictly greater: passing back the last record's own stamp as the next
    // cursor must not return it a second time.
    expect(
      (await listRecordsUpdatedSince<JobRecord>("jobs", first.updatedAt)).map(
        (j) => j.title,
      ),
    ).toEqual(["Second", "Third"]);
    expect(
      await listRecordsUpdatedSince<JobRecord>("jobs", third.updatedAt),
    ).toEqual([]);
  });

  it("includes tombstones, unlike getAllRecords", async () => {
    const job = await saveJob({ title: "Staff Engineer", status: "applied" });
    await tick();
    await deleteJob(job.id);

    expect(await getAllRecords<JobRecord>("jobs")).toEqual([]);
    expect(
      (await listRecordsUpdatedSince<JobRecord>("jobs", 0)).map((j) => j.id),
    ).toEqual([job.id]);
    expect(
      (await getAllRecords<JobRecord>("jobs", { includeDeleted: true })).map(
        (j) => j.id,
      ),
    ).toEqual([job.id]);
  });
});

describe("storage: sync cursors (#730)", () => {
  it("is undefined until a store has been replicated", async () => {
    expect(await getSyncCursor("jobs")).toBeUndefined();
  });

  it("merges the two cursors instead of clobbering the other direction", async () => {
    await setSyncCursor("jobs", { lastPulledAt: "2026-08-02T10:00:00.123456Z" });
    await setSyncCursor("jobs", { lastPushedAt: 1_700_000_000_000 });

    expect(await getSyncCursor("jobs")).toEqual({
      id: "jobs",
      lastPulledAt: "2026-08-02T10:00:00.123456Z",
      lastPushedAt: 1_700_000_000_000,
    });
  });

  it("keeps the remote clock verbatim, sub-millisecond precision and all", async () => {
    // Held as an opaque string on purpose: parsing it into epoch ms would round
    // it, and a pull cursor that rounds UP skips every record written inside the
    // truncated interval.
    const remote = "2026-08-02T10:00:00.123456+05:30";
    await setSyncCursor("letters", { lastPulledAt: remote });
    expect((await getSyncCursor("letters"))?.lastPulledAt).toBe(remote);
  });

  it("keeps one cursor per store, and survives a reload", async () => {
    await setSyncCursor("jobs", { lastPushedAt: 1 });
    await setSyncCursor("letters", { lastPushedAt: 2 });

    // Drop the cached connection the way a page reload would.
    await closeDB();

    expect((await getSyncCursor("jobs"))?.lastPushedAt).toBe(1);
    expect((await getSyncCursor("letters"))?.lastPushedAt).toBe(2);
    expect(await getSyncCursor("resumes")).toBeUndefined();
  });

  it("stays out of the export document, because it describes THIS device", async () => {
    await setSyncCursor("jobs", { lastPushedAt: 1 });
    expect(Object.keys(await exportAll())).not.toContain("sync");
  });
});

describe("storage: tombstones through export / import (#730)", () => {
  it("carries a deleted job into the file and back as deleted", async () => {
    const kept = await saveJob({ title: "Kept", status: "applied" });
    const dropped = await saveJob({ title: "Dropped", status: "interested" });
    await deleteJob(dropped.id);

    const doc = await exportAll();
    expect(doc.jobs.map((j) => j.title).sort()).toEqual(["Dropped", "Kept"]);

    await importAll(doc, "replace");

    expect((await getAllJobs()).map((j) => j.title)).toEqual(["Kept"]);
    expect(
      (await getRecord<JobRecord>("jobs", dropped.id))?.deletedAt,
    ).toBeDefined();
    expect((await getAllJobs()).map((j) => j.id)).toEqual([kept.id]);
  });

  it("counts LIVE records, so a restore does not claim to bring back a deletion", async () => {
    const job = await saveJob({ title: "Kept", status: "applied" });
    await saveLetter({ jobId: job.id, body: "Dear Northwind," });
    const dropped = await saveJob({ title: "Dropped", status: "interested" });
    await deleteJob(dropped.id);

    const counts = await importAll(await exportAll(), "replace");

    expect(counts.jobs).toBe(1);
    expect(counts.letters).toBe(1);
    expect(counts.skippedJobs).toEqual([]);
  });

  it("a merge import propagates the deletion instead of resurrecting the job", async () => {
    // The motivating case, stated as two devices. Device A deletes a job it
    // shares with device B; B merges A's file. Before tombstones, the job was
    // simply missing from A's file, B kept it live, and B's next export handed
    // it back to A.
    const shared = await saveJob({ title: "Shared", status: "applied" });
    await deleteJob(shared.id);
    const deviceAFile = await exportAll();

    // Device B: same job id, still live, plus one of its own.
    await closeDB();
    await deleteDB(DB_NAME);
    await saveJob({ id: shared.id, title: "Shared", status: "applied" });
    await saveJob({ title: "B's own", status: "interested" });

    const counts = await importAll(deviceAFile, "merge");

    expect((await getAllJobs()).map((j) => j.title)).toEqual(["B's own"]);
    expect(counts.jobs).toBe(0);
  });

  it("preserves each record's own updatedAt rather than collapsing them into one instant", async () => {
    // Pre-#730 a restore stamped `now` on every record, so a library the user
    // had built over months came back ordered by whatever sequence the import
    // loop happened to write in — and, once `updatedAt` became a replication
    // cursor, looked to a replicator like every record had just changed.
    const older = await saveJob({ title: "Older", status: "applied" });
    await tick();
    const newer = await saveJob({ title: "Newer", status: "interested" });

    const doc = await exportAll();
    await tick();
    await importAll(doc, "replace");

    const restored = await listJobs();
    expect(restored.map((j) => j.title)).toEqual(["Newer", "Older"]);
    expect(restored.map((j) => j.updatedAt)).toEqual([
      newer.updatedAt,
      older.updatedAt,
    ]);
  });

  it("round-trips a tombstone unchanged, so export → import → export is stable", async () => {
    const job = await saveJob({ title: "Dropped", status: "interested" });
    await deleteJob(job.id);

    const first = await exportAll();
    await importAll(first, "replace");
    const second = await exportAll();

    expect(second.jobs).toEqual(first.jobs);
  });
});

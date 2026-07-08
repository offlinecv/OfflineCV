// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Storage foundation tests (#321). Runs against `fake-indexeddb` (imported via
 * `/auto`, which installs a global `indexedDB`), so the real `idb` code path is
 * exercised without a browser. Each test starts from a freshly-deleted database
 * so schema-upgrade and CRUD cases don't bleed into each other.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, getDB, closeDB } from "./db.ts";
import { saveResume, getResume, getAllResumes, deleteResume } from "./resumes.ts";
import { saveJob, getAllJobs } from "./jobs.ts";
import { exportAll, importAll } from "./backup.ts";
import { requestStoragePersistence, isStoragePersisted } from "./persist.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

const bytes = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]); // "%PDF" + binary
const pdf = () => new Blob([bytes()], { type: "application/pdf" });

async function blobBytes(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

describe("storage: schema", () => {
  it("upgrades an empty/v0 database to both stores", async () => {
    const db = await getDB();
    expect(db.objectStoreNames.contains("resumes")).toBe(true);
    expect(db.objectStoreNames.contains("jobs")).toBe(true);
  });
});

describe("storage: resumes CRUD", () => {
  it("round-trips a Blob byte-identically through save + get", async () => {
    const saved = await saveResume({ filename: "cv.pdf", blob: pdf() });
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBe(saved.updatedAt);

    const loaded = await getResume(saved.id);
    expect(loaded).toBeDefined();
    expect(loaded!.filename).toBe("cv.pdf");
    expect(loaded!.blob).toBeInstanceOf(Blob);
    expect(await blobBytes(loaded!.blob)).toEqual([...bytes()]);
  });

  it("preserves createdAt but advances updatedAt on update", async () => {
    const a = await saveResume({ filename: "cv.pdf", blob: pdf() });
    const b = await saveResume({
      id: a.id,
      filename: "cv-v2.pdf",
      blob: pdf(),
      parse: { ok: true },
    });
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(b.parse).toEqual({ ok: true });
    expect(await getAllResumes()).toHaveLength(1); // update, not insert
  });

  it("deletes a resume", async () => {
    const a = await saveResume({ filename: "cv.pdf", blob: pdf() });
    await deleteResume(a.id);
    expect(await getResume(a.id)).toBeUndefined();
  });
});

describe("storage: jobs CRUD", () => {
  it("saves a job with a generated id and open fields", async () => {
    const job = await saveJob({ title: "SWE", url: "https://example.com/j/1" });
    expect(job.id).toBeTruthy();
    expect(job.title).toBe("SWE");
    expect(await getAllJobs()).toHaveLength(1);
  });
});

describe("storage: export / import", () => {
  it("restores byte-identical resume blobs across a full round-trip", async () => {
    await saveResume({ filename: "cv.pdf", blob: pdf(), parse: { score: 72 } });
    await saveJob({ title: "SWE" });

    const dump = await exportAll();
    expect(dump.resumes).toHaveLength(1);
    expect(dump.resumes[0].blobBase64).toBeTruthy();
    expect(dump.jobs).toHaveLength(1);

    // Wipe everything, then import.
    await closeDB();
    await deleteDB(DB_NAME);
    const counts = await importAll(dump);
    expect(counts).toEqual({ resumes: 1, jobs: 1 });

    const [restored] = await getAllResumes();
    expect(restored.filename).toBe("cv.pdf");
    expect(restored.parse).toEqual({ score: 72 });
    expect(restored.blob.type).toBe("application/pdf");
    expect(await blobBytes(restored.blob)).toEqual([...bytes()]);
  });

  it("rejects an unknown export version", async () => {
    await expect(
      // @ts-expect-error — deliberately wrong version for the guard
      importAll({ version: 99, exportedAt: 0, resumes: [], jobs: [] }),
    ).rejects.toThrow(/Unsupported storage export version/);
  });
});

describe("storage: persistence guards", () => {
  it("no-ops safely when navigator.storage is absent (Node env)", async () => {
    expect(await requestStoragePersistence()).toBe(false);
    expect(await isStoragePersisted()).toBe(false);
  });
});

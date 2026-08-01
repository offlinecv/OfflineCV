// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
import {
  saveResume,
  getResume,
  getAllResumes,
  deleteResume,
  listResumeChoices,
} from "./resumes.ts";
import { saveJob, getAllJobs } from "./jobs.ts";
import { exportAll, exportToJson, importAll, importFromJson } from "./backup.ts";
import { captureJob } from "./capture.ts";
import { requestStoragePersistence, isStoragePersisted } from "./persist.ts";
import { tick } from "./__test-utils__/clock.ts";
import type { JobRecord, StorageExport } from "./types.ts";

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

describe("storage: listResumeChoices (#712)", () => {
  it("lists id/filename/updatedAt newest first, with no blob or parse", async () => {
    const a = await saveResume({ filename: "a.pdf", blob: pdf(), parse: { score: 1 } });
    // Past the millisecond before the second save: two writes inside one
    // `Date.now()` tick give equal sort keys, and "newest first" then decides
    // nothing — the assertion would pass or fail on how loaded the machine is.
    await tick();
    const b = await saveResume({ filename: "b.pdf", blob: pdf(), parse: { score: 2 } });
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);

    const choices = await listResumeChoices();
    expect(choices).toEqual([
      { id: b.id, filename: "b.pdf", updatedAt: b.updatedAt },
      { id: a.id, filename: "a.pdf", updatedAt: a.updatedAt },
    ]);
  });

  it("carries no Blob and is structured-cloneable — the property the bridge depends on", async () => {
    await saveResume({ filename: "cv.pdf", blob: pdf(), parse: { score: 72 } });
    const choices = await listResumeChoices();
    expect(choices).toHaveLength(1);
    for (const choice of choices) {
      for (const value of Object.values(choice)) {
        expect(value).not.toBeInstanceOf(Blob);
      }
    }
    expect(structuredClone(choices)).toEqual(choices);
  });

  it("returns an empty list when nothing is saved", async () => {
    expect(await listResumeChoices()).toEqual([]);
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
    expect(counts).toEqual({
      resumes: 1,
      jobs: 1,
      skippedJobs: [],
      letters: 0,
      skippedLetters: [],
    });

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

  it("merges an import: records saved after the snapshot survive, in-snapshot records upsert by id", async () => {
    const a = await saveResume({ filename: "a.pdf", blob: pdf() });
    const dump = await exportAll(); // snapshot: only `a`

    // Saved AFTER the snapshot was taken — replace mode would wipe this;
    // merge mode must not.
    const b = await saveResume({ filename: "b.pdf", blob: pdf() });

    const counts = await importAll(dump, "merge");
    expect(counts).toEqual({
      resumes: 1,
      jobs: 0,
      skippedJobs: [],
      letters: 0,
      skippedLetters: [],
    });

    const all = await getAllResumes();
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  describe("importFromJson: validation", () => {
    it("rejects a non-JSON string without touching storage", async () => {
      await saveResume({ filename: "cv.pdf", blob: pdf() });
      await expect(importFromJson("not json", "replace")).rejects.toThrow(
        /isn't valid JSON/,
      );
      expect(await getAllResumes()).toHaveLength(1);
    });

    it("rejects well-formed JSON that isn't a backup document", async () => {
      await saveResume({ filename: "cv.pdf", blob: pdf() });
      await expect(
        importFromJson(JSON.stringify({ hello: "world" }), "replace"),
      ).rejects.toThrow(/Not an offlinecv backup file/);
      expect(await getAllResumes()).toHaveLength(1);
    });

    it("rejects a version mismatch by name, without touching storage even in replace mode", async () => {
      await saveResume({ filename: "cv.pdf", blob: pdf() });
      // 3, not 2: 2 became a real format when the letters store landed (#711).
      const doc = JSON.stringify({
        version: 3,
        exportedAt: 0,
        resumes: [],
        jobs: [],
      });
      await expect(importFromJson(doc, "replace")).rejects.toThrow(
        /Unsupported storage export version: 3/,
      );
      expect(await getAllResumes()).toHaveLength(1);
    });

    it("round-trips a valid export through JSON merge mode", async () => {
      await saveResume({ filename: "cv.pdf", blob: pdf(), parse: { score: 72 } });
      await saveJob({ title: "SWE" });
      const json = await exportToJson();

      await closeDB();
      await deleteDB(DB_NAME);

      const counts = await importFromJson(json, "merge");
      expect(counts).toEqual({
        resumes: 1,
        jobs: 1,
        skippedJobs: [],
        letters: 0,
        skippedLetters: [],
      });
      expect(await getAllResumes()).toHaveLength(1);
    });
  });
});

/** A backup document carrying exactly the jobs given, with no resumes — the
 *  shape the import-validation cases perturb one job of. */
function backupWith(jobs: unknown[]): StorageExport {
  return {
    version: 1,
    exportedAt: Date.now(),
    resumes: [],
    jobs: jobs as JobRecord[],
  };
}

function validJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    title: "Senior Frontend Engineer",
    company: "Acme",
    status: "applied",
    ...overrides,
  };
}

describe("storage: import routes every job through the capture contract (#693)", () => {
  it("skips a malformed job, imports the rest, and names what it skipped", async () => {
    const counts = await importAll(
      backupWith([
        validJob(),
        validJob({ id: "job-2", title: 42 }),
        validJob({ id: "job-3", url: "javascript:alert(1)" }),
      ]),
    );

    expect(counts.jobs).toBe(1);
    expect(counts.skippedJobs).toHaveLength(2);
    expect(counts.skippedJobs.map((s) => s.id)).toEqual(["job-2", "job-3"]);
    expect(counts.skippedJobs[1].reason).toContain("`url`");

    const stored = await getAllJobs();
    expect(stored.map((j) => j.id)).toEqual(["job-1"]);
  });

  it("keeps the resumes from a file whose jobs are all malformed", async () => {
    // The losing case for "reject the whole document": one bad job must not
    // cost the user their saved resumes.
    await saveResume({ filename: "cv.pdf", blob: pdf() });
    const dump = await exportAll();
    const counts = await importAll(
      { ...dump, jobs: [validJob({ title: null })] as unknown as JobRecord[] },
      "replace",
    );
    expect(counts.resumes).toBe(1);
    expect(counts.skippedJobs).toHaveLength(1);
    expect(await getAllResumes()).toHaveLength(1);
  });

  it("completes a replace whose only job is malformed, reporting the skip", async () => {
    await saveJob({ title: "Keep me", status: "applied" });
    const counts = await importAll(backupWith([validJob({ id: "job-9", title: 7 })]), "replace");
    expect(counts.jobs).toBe(0);
    expect(counts.skippedJobs).toHaveLength(1);
    expect(await getAllJobs()).toHaveLength(0);
    // NOTE: this does not prove validation runs before `clearStore` — with
    // skip-don't-throw the ordering is unobservable from outside, which is
    // precisely why it was chosen. The ordering is what keeps it unobservable
    // if a future change ever makes a refusal throw; see `importAll`'s docblock.
  });

  it("preserves an out-of-union status and an unknown extra key through the import", async () => {
    await importAll(
      backupWith([validJob({ status: "screening", salaryRange: "180-220k" })]),
    );
    const [stored] = await getAllJobs();
    expect(stored.status).toBe("screening");
    expect((stored as unknown as Record<string, unknown>).salaryRange).toBe("180-220k");
  });

  it("still round-trips a document this app produced itself", async () => {
    // The backward-compatibility check: nothing the app can write today is
    // refused by the new gate. `saveJob` here omits `status` entirely, which
    // the contract defaults rather than refuses.
    await saveJob({ title: "SWE", url: "https://acme.com/jobs/1" });
    await saveJob({ title: "No status set" });
    const json = await exportToJson();

    await closeDB();
    await deleteDB(DB_NAME);

    const counts = await importFromJson(json, "replace");
    expect(counts).toEqual({
      resumes: 0,
      jobs: 2,
      skippedJobs: [],
      letters: 0,
      skippedLetters: [],
    });
    expect((await getAllJobs()).every((j) => j.status === "interested")).toBe(true);
  });
});

describe("storage: captureJob converges on one record per posting (#693)", () => {
  const posting = "https://boards.greenhouse.io/acme/jobs/4012345";

  it("collapses two captures of the same posting that differ only by tracking parameters", async () => {
    const first = await captureJob({ title: "Staff Engineer", url: `${posting}?utm_source=li` });
    const second = await captureJob({
      title: "Staff Engineer",
      url: `${posting}/?gclid=abc&ref=twitter#apply`,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(first.record.id).toBe("job:boards.greenhouse.io/acme/jobs/4012345");
    expect(await getAllJobs()).toHaveLength(1);
  });

  it("keeps two different postings apart", async () => {
    await captureJob({ title: "A", url: "https://acme.com/jobs/1" });
    await captureJob({ title: "B", url: "https://acme.com/jobs/2" });
    expect(await getAllJobs()).toHaveLength(2);
  });

  it("does not reset the user's status, notes or resume link on a re-capture", async () => {
    const first = await captureJob({ title: "Staff Engineer", url: posting });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await saveJob({
      ...first.record,
      status: "interviewing",
      notes: "call on Thursday",
      resumeId: "resume-7",
    });

    const again = await captureJob({ title: "Staff Engineer (updated)", url: posting });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.status).toBe("interviewing");
    expect(again.record.notes).toBe("call on Thursday");
    expect(again.record.resumeId).toBe("resume-7");
    // The producer IS authoritative about the posting itself.
    expect(again.record.title).toBe("Staff Engineer (updated)");
  });

  it("falls back to a fresh id when there is no usable posting URL, and says so by not converging", async () => {
    await captureJob({ title: "Referred by a friend" });
    await captureJob({ title: "Referred by a friend" });
    expect(await getAllJobs()).toHaveLength(2);
  });

  it("refuses a capture the contract rejects, without writing anything", async () => {
    const result = await captureJob({ title: "X", url: "javascript:alert(1)" });
    expect(result.ok).toBe(false);
    expect(await getAllJobs()).toHaveLength(0);
  });

  it("ignores a producer's own timestamps so a wrong clock can't bury or float a capture", async () => {
    const result = await captureJob({
      title: "Staff Engineer",
      url: posting,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.updatedAt).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("storage: persistence guards", () => {
  it("no-ops safely when navigator.storage is absent (Node env)", async () => {
    expect(await requestStoragePersistence()).toBe(false);
    expect(await isStoragePersisted()).toBe(false);
  });
});

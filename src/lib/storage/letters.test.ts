// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Letters store, contract, and migration (#711).
 *
 * Kept out of `storage.test.ts` for one reason that is not tidiness: the
 * migration cases below open the database at version 2 BY HAND — the shape a
 * user's browser is already holding — and then let `getDB()` upgrade it. That
 * needs the shipped `upgrade()` blocks to be replayed exactly, so the file
 * carries its own fixtures and its own delete-first `beforeEach` rather than
 * sharing state with the CRUD suites.
 *
 * Everything here is synthetic: `@example.com`, no real person, and a letter
 * body that names a company that does not exist.
 */

import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, getDB, closeDB } from "./db.ts";
import {
  saveLetter,
  getLetter,
  getAllLetters,
  lettersForJob,
  deleteLetter,
  deleteLettersForJob,
  clearLetterResumeLink,
} from "./letters.ts";
import { saveJob, getAllJobs, deleteJob } from "./jobs.ts";
import { saveResume, getAllResumes } from "./resumes.ts";
import { validateLetterRecord, LETTER_RECORD_RULES } from "./letter-contract.ts";
import { exportAll, exportToJson, importAll, importFromJson } from "./backup.ts";
import { tick } from "./__test-utils__/clock.ts";
import type { LetterRecord, StorageExport } from "./types.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

const pdf = () => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" });

const BODY = "Dear hiring team,\n\nI am applying for the Staff Engineer role at Northwind.";

describe("storage: letters CRUD (#711)", () => {
  it("round-trips a letter through save + get, with a generated id and matched timestamps", async () => {
    const saved = await saveLetter({ jobId: "job-1", body: BODY, label: "First draft" });
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBe(saved.updatedAt);

    const loaded = await getLetter(saved.id);
    expect(loaded).toEqual(saved);
    expect(loaded!.body).toBe(BODY);
    expect(loaded!.label).toBe("First draft");
  });

  it("preserves createdAt but advances updatedAt on an edit", async () => {
    const a = await saveLetter({ jobId: "job-1", body: "v1" });
    const b = await saveLetter({ id: a.id, jobId: "job-1", body: "v2" });
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(await getAllLetters()).toHaveLength(1); // update, not insert
  });

  it("holds several drafts for one job — the reason letters are a store, not a field", async () => {
    const warm = await saveLetter({ jobId: "job-1", body: "draft one", label: "Warm" });
    await tick();
    const direct = await saveLetter({ jobId: "job-1", body: "draft two", label: "Direct" });
    await saveLetter({ jobId: "job-2", body: "other job" });

    const forJob = await lettersForJob("job-1");
    expect(forJob).toHaveLength(2);
    expect(direct.updatedAt).toBeGreaterThan(warm.updatedAt);
    expect(forJob.map((l) => l.id)).toEqual([direct.id, warm.id]); // newest first
    expect(await lettersForJob("job-3")).toEqual([]);
  });

  it("deletes one letter without touching its siblings", async () => {
    const a = await saveLetter({ jobId: "job-1", body: "keep" });
    const b = await saveLetter({ jobId: "job-1", body: "drop" });
    await deleteLetter(b.id);
    expect(await getLetter(b.id)).toBeUndefined();
    expect((await lettersForJob("job-1")).map((l) => l.id)).toEqual([a.id]);
  });
});

describe("storage: letters follow their job and their résumé (#711)", () => {
  it("CASCADES: deleting a job deletes its letters, and only its letters", async () => {
    const job = await saveJob({ title: "Staff Engineer" });
    const other = await saveJob({ title: "Principal Engineer" });
    await saveLetter({ jobId: job.id, body: "draft one" });
    await saveLetter({ jobId: job.id, body: "draft two" });
    const survivor = await saveLetter({ jobId: other.id, body: "different job" });

    await deleteJob(job.id);

    // The decision documented in `docs/cover-letter-contract.md` §5: a letter
    // whose job is gone is unreachable from every surface, so orphaning it
    // would only grow the store invisibly.
    expect(await lettersForJob(job.id)).toEqual([]);
    expect((await getAllLetters()).map((l) => l.id)).toEqual([survivor.id]);
    expect((await getAllJobs()).map((j) => j.id)).toEqual([other.id]);
  });

  it("cascade is a no-op for a job that never had a letter", async () => {
    const job = await saveJob({ title: "Staff Engineer" });
    await saveLetter({ jobId: "some-other-job", body: "unrelated" });
    expect(await deleteLettersForJob(job.id)).toBe(0);
    expect(await getAllLetters()).toHaveLength(1);
  });

  it("CLEARS, not cascades, on résumé delete — and leaves updatedAt untouched", async () => {
    const resume = await saveResume({ filename: "cv.pdf", blob: pdf() });
    const linked = await saveLetter({ jobId: "job-1", body: BODY, resumeId: resume.id });
    const unlinked = await saveLetter({ jobId: "job-1", body: "no résumé" });

    // Past the millisecond, so a spurious `updatedAt` stamp would be visible.
    await tick();
    expect(await clearLetterResumeLink(resume.id)).toBe(1);

    const after = await getLetter(linked.id);
    expect(after!.resumeId).toBeUndefined();
    expect(after!.body).toBe(BODY); // the prose is not the résumé's to take
    // The `touch: false` requirement: a write the USER did not make must not
    // reshuffle a most-recently-updated-first list.
    expect(after!.updatedAt).toBe(linked.updatedAt);
    expect(after!.createdAt).toBe(linked.createdAt);

    expect((await getLetter(unlinked.id))!.updatedAt).toBe(unlinked.updatedAt);
  });

  it("clearing a résumé link is idempotent and a no-op when nothing linked it", async () => {
    await saveLetter({ jobId: "job-1", body: BODY, resumeId: "resume-1" });
    expect(await clearLetterResumeLink("resume-1")).toBe(1);
    expect(await clearLetterResumeLink("resume-1")).toBe(0);
    expect(await clearLetterResumeLink("resume-never-existed")).toBe(0);
  });

  it("keeps unknown extra keys through a résumé-link clear", async () => {
    // The link clear spreads the stored record back through `saveLetter`. A
    // strict input shape would silently drop whatever the contract preserved on
    // import — data loss caused by a housekeeping write.
    await importAll(
      backupWith([
        {
          id: "letter-1",
          jobId: "job-1",
          body: BODY,
          resumeId: "resume-1",
          tone: "warm",
        },
      ]),
    );
    await clearLetterResumeLink("resume-1");
    const [stored] = await getAllLetters();
    expect(stored.resumeId).toBeUndefined();
    expect((stored as unknown as Record<string, unknown>).tone).toBe("warm");
  });
});

describe("storage: letters schema migration v2 → v3 (#711)", () => {
  /** Recreate a database exactly as `DB_VERSION = 2` shipped it — the state a
   *  returning user's browser is holding. Replays the shipped upgrade blocks
   *  rather than asserting against them. */
  async function seedV2Profile(): Promise<void> {
    const legacy = await openDB(DB_NAME, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("resumes", { keyPath: "id" });
          db.createObjectStore("jobs", { keyPath: "id" });
        }
        if (oldVersion < 2) {
          db.createObjectStore("boards", { keyPath: "id" });
        }
      },
    });
    await legacy.put("resumes", {
      id: "resume-1",
      filename: "cv.pdf",
      blob: pdf(),
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await legacy.put("jobs", {
      id: "job-1",
      title: "Staff Engineer",
      company: "Northwind",
      status: "applied",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    legacy.close();
  }

  it("opens an existing v2 profile with resumes and jobs intact and letters empty", async () => {
    await seedV2Profile();

    const db = await getDB();
    // Read the OPEN database's version, not the module constant — a test that
    // compared `DB_VERSION` to itself would pass even if `upgrade()` never ran.
    //
    // The literal moves with every schema bump (4 since #730) because a v2
    // profile migrates ALL the way forward, not one step: `upgrade()` runs for
    // the whole range `(oldVersion, DB_VERSION]`. What this case is actually
    // about is the `letters` store below — that a profile written before it
    // existed comes back with it present and its resumes and jobs untouched.
    expect(db.version).toBe(4);
    expect(db.objectStoreNames.contains("letters")).toBe(true);

    expect((await getAllResumes()).map((r) => r.filename)).toEqual(["cv.pdf"]);
    expect((await getAllJobs()).map((j) => j.title)).toEqual(["Staff Engineer"]);
    expect(await getAllLetters()).toEqual([]);
    // `boards` survived the additive migration too.
    expect(db.objectStoreNames.contains("boards")).toBe(true);
  });

  it("the migrated store is writable, so an upgraded profile is not read-only", async () => {
    await seedV2Profile();
    const letter = await saveLetter({ jobId: "job-1", body: BODY });
    expect((await getAllLetters()).map((l) => l.id)).toEqual([letter.id]);
  });

  // The four RECORD stores. `sync` (v4, #730) holds bookmarks rather than
  // records and is covered by `sync-schema.test.ts`.
  it("creates all four record stores on a fresh v0 database", async () => {
    const db = await getDB();
    for (const store of ["resumes", "jobs", "boards", "letters"] as const) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
  });
});

/** A valid candidate letter — the baseline each contract case perturbs one
 *  field of. */
function validLetter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "letter-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    jobId: "job-1",
    resumeId: "resume-1",
    body: BODY,
    label: "First draft",
    producer: {
      contract: 1,
      producer: "claude-code-letter-skill",
      producerVersion: "0.1.0",
      generatedAt: 1_700_000_000_500,
    },
    ...overrides,
  };
}

describe("storage: letter contract (#711)", () => {
  it("accepts the fully-populated baseline unchanged", () => {
    const result = validateLetterRecord(validLetter());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual(validLetter());
  });

  it("names a missing jobId, a non-string body, and a non-JSON-safe field", () => {
    const missingJob = validateLetterRecord(validLetter({ jobId: undefined }));
    expect(missingJob.ok).toBe(false);
    if (missingJob.ok) return;
    expect(missingJob.reasons.join(" ")).toContain("`jobId` is required");

    const badBody = validateLetterRecord(validLetter({ body: 42 }));
    expect(badBody.ok).toBe(false);
    if (badBody.ok) return;
    expect(badBody.reasons.join(" ")).toContain("`body` must be a string");

    // The JSON-safety bar applies to unknown extras too: a `Date` under a key
    // this build has never heard of would silently become a string on the next
    // export, so it refuses the record and names the path.
    const notJsonSafe = validateLetterRecord(validLetter({ draftedOn: new Date() }));
    expect(notJsonSafe.ok).toBe(false);
    if (notJsonSafe.ok) return;
    expect(notJsonSafe.reasons.join(" ")).toContain("record.draftedOn");
    expect(notJsonSafe.reasons.join(" ")).toContain("Date");
  });

  it("refuses an empty jobId but accepts an empty body", () => {
    // A letter with no job is reachable from nothing; an empty draft is a state
    // the user can plainly see and fix.
    expect(validateLetterRecord(validLetter({ jobId: "" })).ok).toBe(false);
    expect(validateLetterRecord(validLetter({ body: "" })).ok).toBe(true);
  });

  it("refuses a non-object, and a record carrying a __proto__ key", () => {
    for (const candidate of [null, 42, "letter", [validLetter()]]) {
      expect(validateLetterRecord(candidate).ok).toBe(false);
    }
    const polluted = JSON.parse(
      '{"id":"l1","jobId":"j1","body":"x","__proto__":{"admin":true}}',
    ) as unknown;
    const result = validateLetterRecord(polluted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toContain("__proto__");
  });

  it("refuses provenance with no contract number, and accepts provenance with only one", () => {
    expect(validateLetterRecord(validLetter({ producer: { producer: "x" } })).ok).toBe(false);
    expect(validateLetterRecord(validLetter({ producer: { contract: 1 } })).ok).toBe(true);
    expect(
      validateLetterRecord(validLetter({ producer: { contract: 1, generatedAt: "yesterday" } })).ok,
    ).toBe(false);
  });

  it("preserves unknown extra keys rather than stripping them", () => {
    const result = validateLetterRecord(validLetter({ tone: "warm", revision: 3 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.record as unknown as Record<string, unknown>;
    expect(record.tone).toBe("warm");
    expect(record.revision).toBe(3);
  });

  it.each(Object.keys(LETTER_RECORD_RULES))(
    "the rule for `%s` actually rejects something",
    (field) => {
      // The runtime half of the drift guard: a rule added only to satisfy the
      // mapped type, whose `check` accepts everything, fails here. `{}` is not
      // a string, not a number, and not valid provenance.
      const rule = LETTER_RECORD_RULES[field as keyof LetterRecord];
      expect(rule.check({})).toBe(false);
      expect(rule.expected.length).toBeGreaterThan(0);
    },
  );
});

/** A backup document carrying exactly the letters given, and nothing else. */
function backupWith(letters: unknown[]): StorageExport {
  return {
    version: 2,
    exportedAt: Date.now(),
    resumes: [],
    jobs: [],
    letters: letters as LetterRecord[],
  };
}

describe("storage: letters through export / import (#711)", () => {
  it("round-trips a letter unchanged, at document version 2", async () => {
    const job = await saveJob({ title: "Staff Engineer" });
    const saved = await saveLetter({
      jobId: job.id,
      body: BODY,
      label: "First draft",
      resumeId: "resume-1",
    });

    const dump = await exportAll();
    expect(dump.version).toBe(2);
    expect(dump.letters).toEqual([saved]);

    await closeDB();
    await deleteDB(DB_NAME);

    const counts = await importAll(dump);
    expect(counts.letters).toBe(1);
    expect(counts.skippedLetters).toEqual([]);

    // Every field survives except `updatedAt`, which `putRecord` restamps on
    // any write that doesn't opt out — the pre-existing rule for resumes and
    // jobs too, not something letters are singled out for. `createdAt` is what
    // a restore preserves, and it is asserted exactly.
    const [restored] = await getAllLetters();
    expect(restored).toEqual({ ...saved, updatedAt: expect.any(Number) });
    expect(restored.createdAt).toBe(saved.createdAt);
  });

  it("survives the JSON string round-trip, not just the in-memory object", async () => {
    const saved = await saveLetter({ jobId: "job-1", body: BODY, label: "First draft" });
    const json = await exportToJson();

    await closeDB();
    await deleteDB(DB_NAME);

    const counts = await importFromJson(json, "replace");
    expect(counts.letters).toBe(1);
    const [restored] = await getAllLetters();
    expect(restored.id).toBe(saved.id);
    expect(restored.body).toBe(BODY);
    expect(restored.label).toBe("First draft");
    expect(restored.createdAt).toBe(saved.createdAt);
  });

  it("imports a v1 document, which has no `letters` key at all", async () => {
    // The back-compat requirement, stated as the file a user already has on
    // disk: an exported backup never learns about a format bump.
    const v1 = JSON.stringify({
      version: 1,
      exportedAt: 1_700_000_000_000,
      resumes: [],
      jobs: [
        {
          id: "job-1",
          title: "Staff Engineer",
          company: "Northwind",
          status: "applied",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ],
    });

    const counts = await importFromJson(v1, "replace");
    expect(counts.jobs).toBe(1);
    expect(counts.letters).toBe(0);
    expect(counts.skippedLetters).toEqual([]);
    expect(await getAllLetters()).toEqual([]);
  });

  it("replace mode wipes letters even from a v1 document, so no letter outlives its job", async () => {
    const job = await saveJob({ title: "Staff Engineer" });
    await saveLetter({ jobId: job.id, body: BODY });

    // A v1 backup restores jobs from scratch; leaving the letters behind would
    // strand them on a jobId the restore just deleted — exactly the orphan the
    // `deleteJob` cascade exists to make impossible.
    const v1 = JSON.stringify({ version: 1, exportedAt: 0, resumes: [], jobs: [] });
    await importFromJson(v1, "replace");
    expect(await getAllLetters()).toEqual([]);
  });

  it("skips a malformed letter, imports the rest, and names what it skipped", async () => {
    const counts = await importAll(
      backupWith([
        validLetter(),
        validLetter({ id: "letter-2", label: "Second", jobId: undefined }),
        validLetter({ id: "letter-3", body: null }),
      ]),
    );

    expect(counts.letters).toBe(1);
    expect(counts.skippedLetters).toHaveLength(2);
    expect(counts.skippedLetters.map((s) => s.id)).toEqual(["letter-2", "letter-3"]);
    expect(counts.skippedLetters[0].label).toBe("Second");
    expect(counts.skippedLetters[0].reason).toContain("`jobId`");
    expect((await getAllLetters()).map((l) => l.id)).toEqual(["letter-1"]);
  });

  it("one malformed letter costs the user nothing else in the file", async () => {
    await saveResume({ filename: "cv.pdf", blob: pdf() });
    await saveJob({ title: "Staff Engineer" });
    const dump = await exportAll();

    const counts = await importAll(
      { ...dump, letters: [validLetter({ jobId: 7 })] as unknown as LetterRecord[] },
      "replace",
    );
    expect(counts.resumes).toBe(1);
    expect(counts.jobs).toBe(1);
    expect(counts.letters).toBe(0);
    expect(counts.skippedLetters).toHaveLength(1);
    expect(await getAllResumes()).toHaveLength(1);
  });

  it("rejects a v2 document whose `letters` key is missing, as a wrong-file pick", async () => {
    // Not a v1 document: the version number is the file's own claim about its
    // shape, and a file that fails its own claim is malformed.
    const doc = JSON.stringify({ version: 2, exportedAt: 0, resumes: [], jobs: [] });
    await expect(importFromJson(doc, "replace")).rejects.toThrow(
      /Not an offlinecv backup file/,
    );
  });
});

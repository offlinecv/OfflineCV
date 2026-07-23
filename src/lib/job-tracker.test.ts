// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Job-tracker domain-layer tests (#323). Runs against `fake-indexeddb` (same
 * harness as the storage foundation), so the real IndexedDB path is exercised
 * offline. Covers the two headline acceptance criteria: CRUD + status
 * transitions end-to-end, and graceful degrade when a linked resume is deleted
 * (link cleared, job kept), plus the JD-match seam the `/jd-fit/` "save this
 * job" button sits on.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, closeDB } from "./storage/db.ts";
import {
  createJob,
  listJobs,
  getJobById,
  updateJob,
  setJobStatus,
  linkResume,
  unlinkResume,
  removeJob,
  clearResumeLink,
  reconcileResumeLinks,
  createTrackedJobFromMatch,
  deriveJobTitleFromJd,
} from "./job-tracker.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

describe("job-tracker: CRUD + status", () => {
  it("creates a job with a default status and managed id/timestamps", async () => {
    const job = await createJob({ title: "Frontend Engineer", company: "Acme" });
    expect(job.id).toBeTruthy();
    expect(job.status).toBe("interested");
    expect(job.createdAt).toBeGreaterThan(0);
    expect(job.updatedAt).toBe(job.createdAt);
    expect(await listJobs()).toHaveLength(1);
  });

  it("allows a blank company and optional fields", async () => {
    const job = await createJob({ title: "SWE" });
    expect(job.company).toBe("");
    expect(job.url).toBeUndefined();
    expect(job.resumeId).toBeUndefined();
  });

  it("updates fields without disturbing the rest, preserving createdAt", async () => {
    const created = await createJob({ title: "SWE", company: "Acme" });
    const updated = await updateJob(created.id, { notes: "referred by Dana" });
    expect(updated.title).toBe("SWE");
    expect(updated.company).toBe("Acme");
    expect(updated.notes).toBe("referred by Dana");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("moves a job through the status lifecycle", async () => {
    const job = await createJob({ title: "SWE" });
    for (const status of ["applied", "interviewing", "offer"] as const) {
      const next = await setJobStatus(job.id, status);
      expect(next.status).toBe(status);
    }
    expect((await getJobById(job.id))?.status).toBe("offer");
  });

  it("lists every saved job (order is updatedAt-descending)", async () => {
    // Timestamps are store-managed (`putRecord` stamps `Date.now()`), so exact
    // tie-break order isn't controllable here; assert completeness, not the
    // sub-millisecond order of the trivial `updatedAt` sort.
    await createJob({ title: "A" });
    await createJob({ title: "B" });
    const titles = (await listJobs()).map((j) => j.title);
    expect(titles).toHaveLength(2);
    expect(titles).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("removes a job", async () => {
    const job = await createJob({ title: "SWE" });
    await removeJob(job.id);
    expect(await listJobs()).toHaveLength(0);
    expect(await getJobById(job.id)).toBeUndefined();
  });

  it("throws when updating a missing job", async () => {
    await expect(updateJob("nope", { status: "applied" })).rejects.toThrow(
      /no job/,
    );
  });
});

describe("job-tracker: resume linking + graceful degrade", () => {
  it("links and unlinks a resume by id", async () => {
    const job = await createJob({ title: "SWE" });
    const linked = await linkResume(job.id, "resume-1");
    expect(linked.resumeId).toBe("resume-1");
    const unlinked = await unlinkResume(job.id);
    expect(unlinked.resumeId).toBeUndefined();
  });

  it("clears the link when the linked resume is deleted, keeping the job", async () => {
    const jobA = await createJob({ title: "A", resumeId: "resume-1" });
    const jobB = await createJob({ title: "B", resumeId: "resume-2" });

    const cleared = await clearResumeLink("resume-1");

    expect(cleared).toBe(1);
    // Job A survives, only its dangling link is gone.
    expect((await getJobById(jobA.id))?.resumeId).toBeUndefined();
    expect((await getJobById(jobA.id))?.title).toBe("A");
    // Job B's unrelated link is untouched.
    expect((await getJobById(jobB.id))?.resumeId).toBe("resume-2");
    expect(await listJobs()).toHaveLength(2);
  });

  it("reconciles links orphaned by any delete path", async () => {
    await createJob({ title: "A", resumeId: "gone" });
    await createJob({ title: "B", resumeId: "stays" });
    const repaired = await reconcileResumeLinks(new Set(["stays"]));
    expect(repaired).toBe(1);
    const jobs = await listJobs();
    expect(jobs.find((j) => j.title === "A")?.resumeId).toBeUndefined();
    expect(jobs.find((j) => j.title === "B")?.resumeId).toBe("stays");
  });
});

describe("job-tracker: save-from-match", () => {
  it("creates an interested job carrying the JD text + match result", async () => {
    const match = { score: 82, missing: ["Rust"] };
    const job = await createTrackedJobFromMatch({
      title: "Platform Engineer",
      company: "Globex",
      jdText: "We are looking for...",
      matchResult: match,
    });
    expect(job.status).toBe("interested");
    expect(job.jdText).toContain("looking for");
    expect(job.matchResult).toEqual(match);
    // Survives a store round-trip (JSON-safe by contract).
    expect((await getJobById(job.id))?.matchResult).toEqual(match);
  });
});

describe("job-tracker: JD title seed", () => {
  it("takes the JD's first non-empty line as the title seed", () => {
    expect(deriveJobTitleFromJd("\n\n  Senior Frontend Engineer  \nAcme Inc\n"))
      .toBe("Senior Frontend Engineer");
  });

  it("falls back to a placeholder when the first line is prose, not a title", () => {
    const prose =
      "We are a fast-growing company looking for someone who can own the " +
      "entire frontend stack and mentor a team of engineers along the way.";
    expect(deriveJobTitleFromJd(prose)).toBe("Untitled job");
  });

  it("falls back to a placeholder for blank input rather than an empty title", () => {
    expect(deriveJobTitleFromJd("   \n\n  ")).toBe("Untitled job");
    expect(deriveJobTitleFromJd("")).toBe("Untitled job");
  });
});

describe("job-tracker: link cleanup is housekeeping, not a user edit", () => {
  it("does not reorder the tracker when an unrelated resume is deleted", async () => {
    const older = await createJob({ title: "Older", resumeId: "resume-1" });
    // `updatedAt` is millisecond-resolution `Date.now()`, so two writes in the
    // same tick tie and the sort order becomes arbitrary. Separate them
    // explicitly — otherwise this test is a coin flip, not a check.
    await new Promise((r) => setTimeout(r, 2));
    const newer = await createJob({ title: "Newer" });
    expect(newer.updatedAt).toBeGreaterThan(older.updatedAt);
    expect((await listJobs()).map((j) => j.title)).toEqual(["Newer", "Older"]);

    await clearResumeLink("resume-1");

    // "Older" lost its dangling link but did not jump to the top.
    expect((await listJobs()).map((j) => j.title)).toEqual(["Newer", "Older"]);
    expect((await getJobById(older.id))?.resumeId).toBeUndefined();
  });

  it("still stamps updatedAt for a real user edit", async () => {
    const job = await createJob({ title: "SWE" });
    const before = job.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    const edited = await updateJob(job.id, { notes: "referred by Dana" });
    expect(edited.updatedAt).toBeGreaterThan(before);
  });
});

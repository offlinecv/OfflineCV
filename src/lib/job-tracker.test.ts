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
  mergeJobs,
  archiveInterestedOlderThan,
  archiveRepostedRoles,
} from "./job-tracker.ts";
import { findRepostClusters } from "./job-repost-clusters.ts";
import { isSweepableBucket, jobsToArchive } from "./job-archive-sweep.ts";
import { archiveJobs } from "./storage/jobs.ts";
import { getRecord, putRecord } from "./storage/crud.ts";
import { saveLetter, lettersForJob } from "./storage/letters.ts";
import type { JobRecord } from "./storage/types.ts";

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

describe("job-tracker: bulk-archive sweep (#759)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.now();

  /** Writes a job straight through `putRecord` with an explicit `createdAt`
   *  — `createJob`/`updateJob` can't backdate one (an update always keeps the
   *  EXISTING row's `createdAt`, by `putRecord`'s own contract), and this
   *  sweep is dated entirely off that field. */
  function plantJob(over: Partial<JobRecord> & { createdAt: number }): Promise<JobRecord> {
    return putRecord<JobRecord>("jobs", {
      id: crypto.randomUUID(),
      title: "SWE",
      company: "Acme",
      status: "interested",
      ...over,
    });
  }

  it("archives an Interested job past the cutoff and returns the swept count", async () => {
    const old = await plantJob({ title: "Old", createdAt: NOW - 60 * DAY_MS });
    const fresh = await plantJob({ title: "Fresh", createdAt: NOW - 5 * DAY_MS });

    const count = await archiveInterestedOlderThan(await listJobs(), 30, NOW);

    expect(count).toBe(1);
    expect((await getJobById(old.id))?.status).toBe("archived");
    expect((await getJobById(fresh.id))?.status).toBe("interested");
  });

  it("never touches an Applied job, however old — the criterion #759 leads with", async () => {
    const applied = await plantJob({
      title: "Already applied",
      status: "applied",
      createdAt: NOW - 400 * DAY_MS,
    });

    const count = await archiveInterestedOlderThan(await listJobs(), 30, NOW);

    expect(count).toBe(0);
    expect((await getJobById(applied.id))?.status).toBe("applied");
  });

  it("SPARES a row that stopped being Interested after the preview was computed", async () => {
    // The confirm dialog promises "Applied, Interviewing, Offer, and Rejected
    // jobs are never touched." Selecting the ids and writing them are two
    // different moments, and the sweep is a sequential awaited loop over as
    // many as ~290 rows — so another tab, the browser extension writing
    // through `putRecord`, or a sync can move a row out of Interested while
    // the sweep is still working through the list. Before the write re-checked
    // the bucket, that row was archived anyway and the hand-built pipeline
    // state was gone.
    //
    // The change is planted between the preview and the call, which is
    // exactly the window: `jobs` is the array the user was counting, and the
    // store no longer agrees with it.
    const sweptAway = await plantJob({ title: "Genuinely old", createdAt: NOW - 60 * DAY_MS });
    const movedOn = await plantJob({ title: "Applied elsewhere", createdAt: NOW - 60 * DAY_MS });

    const jobs = await listJobs();
    expect(jobsToArchive(jobs, 30, NOW)).toHaveLength(2);

    await setJobStatus(movedOn.id, "applied");
    const beforeSweep = await getJobById(movedOn.id);

    const count = await archiveInterestedOlderThan(jobs, 30, NOW);

    // Untouched — not archived, and not even re-stamped.
    const after = await getJobById(movedOn.id);
    expect(after?.status).toBe("applied");
    expect(after?.updatedAt).toBe(beforeSweep?.updatedAt);
    // The other row was still eligible and still swept: the guard skips a row,
    // it does not abandon the sweep.
    expect((await getJobById(sweptAway.id))?.status).toBe("archived");
    // And the count reports writes that happened, not rows that were listed —
    // so the dialog's "Archived N jobs." stays true. This is the one case
    // where it may sit below the preview count.
    expect(count).toBe(1);
  });

  it("spares a row moved out of Interested WHILE the loop is running, not just before it", async () => {
    // The same defect one step further in: the flip lands after the sweep has
    // already written an earlier row, so it cannot be explained away as
    // "stale input". `archiveJobs` re-reads and re-judges each row
    // immediately before that row's own write, so the loop sees it.
    //
    // The flip is issued from `archiveInterestedOlderThan`'s own predicate
    // call for the FIRST row and left un-awaited, so it is queued behind that
    // row's write and settles before the second row is re-read. If that
    // ordering ever changed, the assertions below fail loudly rather than
    // passing for the wrong reason.
    const first = await plantJob({ title: "First", createdAt: NOW - 60 * DAY_MS });
    const second = await plantJob({ title: "Second", createdAt: NOW - 60 * DAY_MS });

    const jobs = await listJobs();
    expect(jobsToArchive(jobs, 30, NOW)).toHaveLength(2);

    let flip: Promise<unknown> | undefined;
    const archived = await archiveJobs(
      [first.id, second.id],
      {
        stillEligible: (job) => {
          if (job.id === first.id && flip === undefined) {
            flip = setJobStatus(second.id, "interviewing");
          }
          return isSweepableBucket(job);
        },
      },
    );
    await flip;

    expect(archived.map((job) => job.id)).toEqual([first.id]);
    expect((await getJobById(first.id))?.status).toBe("archived");
    expect((await getJobById(second.id))?.status).toBe("interviewing");
  });

  it("the swept count matches jobsToArchive's preview count when nothing else writes", async () => {
    // The #759 agreement, stated precisely rather than loosely. It is about
    // POLICY: preview and write run one predicate over one array, so the
    // sweep can never select a row on a rule the preview did not apply, and
    // no cutoff is re-derived at write time.
    //
    // It was never a promise that the two numbers are equal come what may,
    // and since the write re-checks each row's bucket they can legitimately
    // differ — downward, and only when another writer moves a row out of
    // Interested mid-sweep (see the two tests above). This case is the
    // undisturbed one, which is why nothing else touches the store here.
    await plantJob({ title: "Sweep me", createdAt: NOW - 90 * DAY_MS });
    await plantJob({ title: "Keep me", createdAt: NOW - 1 * DAY_MS });
    await plantJob({
      title: "Pipeline",
      status: "interviewing",
      createdAt: NOW - 900 * DAY_MS,
    });

    const jobs = await listJobs();
    const preview = jobsToArchive(jobs, 30, NOW);
    const count = await archiveInterestedOlderThan(jobs, 30, NOW);

    expect(count).toBe(preview.length);
    expect(count).toBe(1);
  });

  it("a cutoff nothing matches archives and writes nothing", async () => {
    const fresh = await plantJob({ title: "Fresh", createdAt: NOW - 1 * DAY_MS });
    const before = await getJobById(fresh.id);

    const count = await archiveInterestedOlderThan(await listJobs(), 30, NOW);

    expect(count).toBe(0);
    const after = await getJobById(fresh.id);
    expect(after?.status).toBe("interested");
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("overwrites a synced saved/scouted status to the literal archived — one-way (#744)", async () => {
    const scouted = await plantJob({
      title: "From a job alert",
      status: "scouted" as JobRecord["status"],
      createdAt: NOW - 60 * DAY_MS,
    });

    const count = await archiveInterestedOlderThan(await listJobs(), 30, NOW);

    expect(count).toBe(1);
    // The producer's own vocabulary ("scouted") is gone — this is the
    // documented one-way write, not a bug.
    expect((await getJobById(scouted.id))?.status).toBe("archived");
  });
});

describe("job-tracker: archiveRepostedRoles", () => {
  const NOW = Date.parse("2026-08-05T00:00:00Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  function plantJob(over: Partial<JobRecord> & { createdAt: number }): Promise<JobRecord> {
    return putRecord<JobRecord>("jobs", {
      id: crypto.randomUUID(),
      title: "SWE",
      company: "Acme",
      status: "interested",
      ...over,
    });
  }

  /** Three captures of one Acme role spread over 100 days — a repost cluster by
   *  `findRepostClusters`' own rule, so the clusters this suite sweeps are the
   *  ones the UI would have derived rather than hand-built literals. */
  async function threeRepostsOfOneRole() {
    return [
      await plantJob({ createdAt: NOW - 100 * DAY_MS }),
      await plantJob({ createdAt: NOW - 50 * DAY_MS }),
      await plantJob({ createdAt: NOW - 1 * DAY_MS }),
    ];
  }

  it("archives every Interested member of a cluster, newest included", async () => {
    const planted = await threeRepostsOfOneRole();
    const jobs = await listJobs();
    const clusters = findRepostClusters(jobs);
    expect(clusters).toHaveLength(1);

    const count = await archiveRepostedRoles(jobs, clusters);

    expect(count).toBe(3);
    for (const job of planted) {
      expect((await getJobById(job.id))?.status).toBe("archived");
    }
  });

  it("leaves the cluster itself standing — the churn evidence outlives the sweep", async () => {
    await threeRepostsOfOneRole();
    const clusters = findRepostClusters(await listJobs());

    await archiveRepostedRoles(await listJobs(), clusters);

    // Clusters are derived over the WHOLE library, archived rows included, so
    // the list still says "reposted 3×" afterwards. This is the property that
    // makes archiving offerable here where a merge was not (#754).
    const after = findRepostClusters(await listJobs());
    expect(after).toHaveLength(1);
    expect(after[0].count).toBe(3);
  });

  it("never touches a pipeline row inside a cluster", async () => {
    await plantJob({ createdAt: NOW - 100 * DAY_MS });
    const applied = await plantJob({ createdAt: NOW - 1 * DAY_MS, status: "applied" });
    const jobs = await listJobs();

    const count = await archiveRepostedRoles(jobs, findRepostClusters(jobs));

    expect(count).toBe(1);
    expect((await getJobById(applied.id))?.status).toBe("applied");
  });

  it("SPARES a row that stopped being Interested after the preview was computed", async () => {
    // Same window `archiveInterestedOlderThan` guards, and the same shared
    // `isSweepableBucket` re-check inside `archiveJobs` closes it: `jobs` is
    // the array the user was counting, and the store no longer agrees with it.
    const planted = await threeRepostsOfOneRole();
    const jobs = await listJobs();
    const clusters = findRepostClusters(jobs);

    await setJobStatus(planted[1].id, "interviewing");
    const beforeSweep = await getJobById(planted[1].id);

    const count = await archiveRepostedRoles(jobs, clusters);

    const after = await getJobById(planted[1].id);
    expect(after?.status).toBe("interviewing");
    expect(after?.updatedAt).toBe(beforeSweep?.updatedAt);
    // The count reports writes that happened, not rows that were listed.
    expect(count).toBe(2);
  });

  it("is a no-op the second time, writing nothing", async () => {
    await threeRepostsOfOneRole();
    const clusters = findRepostClusters(await listJobs());
    await archiveRepostedRoles(await listJobs(), clusters);

    const stamps = (await listJobs()).map((job) => job.updatedAt);
    const count = await archiveRepostedRoles(await listJobs(), clusters);

    expect(count).toBe(0);
    expect((await listJobs()).map((job) => job.updatedAt)).toEqual(stamps);
  });

  it("archives nothing when the library holds no cluster", async () => {
    const lone = await plantJob({ createdAt: NOW - 100 * DAY_MS });
    const before = await getJobById(lone.id);
    const jobs = await listJobs();

    const count = await archiveRepostedRoles(jobs, findRepostClusters(jobs));

    expect(count).toBe(0);
    const after = await getJobById(lone.id);
    expect(after?.status).toBe("interested");
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});

describe("job-tracker: merge is a user action, lossy in one direction only (#746)", () => {
  const AGGREGATOR = "https://jobs.example.com/listing/4012345";
  const ATS = "https://boards.greenhouse.io/acme/jobs/4012345";

  async function twoRowsForOnePosting() {
    const survivor = await createJob({
      title: "Senior Frontend Engineer",
      company: "Acme",
      url: ATS,
      notes: "Referred by Dana.",
      status: "applied",
    });
    const absorbed = await createJob({
      title: "Senior Frontend Engineer",
      company: "Acme",
      url: AGGREGATOR,
      notes: "Recruiter called 12 Aug.",
      jdText: "We are hiring.",
    });
    return { survivor, absorbed };
  }

  it("leaves one record carrying both URLs, with no note text lost", async () => {
    const { survivor, absorbed } = await twoRowsForOnePosting();

    const merged = await mergeJobs(survivor.id, absorbed.id);

    expect(await listJobs()).toHaveLength(1);
    expect(merged.id).toBe(survivor.id);
    expect(merged.url).toBe(ATS);
    expect(merged.aliasUrls).toEqual([AGGREGATOR]);
    expect(merged.notes).toContain("Referred by Dana.");
    expect(merged.notes).toContain("Recruiter called 12 Aug.");
    // A gap on the survivor is filled; a value it already had is kept.
    expect(merged.jdText).toBe("We are hiring.");
    expect(merged.status).toBe("applied");
  });

  it("TOMBSTONES the absorbed record rather than removing the row", async () => {
    // A hard delete is indistinguishable from "never existed" to any second
    // holder of this library, which would hand the duplicate straight back.
    const { survivor, absorbed } = await twoRowsForOnePosting();
    await mergeJobs(survivor.id, absorbed.id);

    expect(await getJobById(absorbed.id)).toBeUndefined();
    const row = await getRecord<JobRecord>("jobs", absorbed.id);
    expect(row?.deletedAt).toBeGreaterThan(0);
  });

  it("does not change the surviving record's id", async () => {
    const { survivor, absorbed } = await twoRowsForOnePosting();
    await mergeJobs(survivor.id, absorbed.id);
    expect((await getJobById(survivor.id))?.id).toBe(survivor.id);
  });

  it("reparents the absorbed job's cover letters instead of cascading them away", async () => {
    // `deleteJob` cascades to letters (#711). A merge that destroyed the letter
    // the user wrote for this posting would be the over-merge this feature
    // exists to avoid.
    const { survivor, absorbed } = await twoRowsForOnePosting();
    await saveLetter({ jobId: absorbed.id, body: "Dear hiring team," });

    await mergeJobs(survivor.id, absorbed.id);

    expect(await lettersForJob(absorbed.id)).toHaveLength(0);
    const kept = await lettersForJob(survivor.id);
    expect(kept).toHaveLength(1);
    expect(kept[0].body).toBe("Dear hiring team,");
  });

  it("refuses to merge a job into itself", async () => {
    const job = await createJob({ title: "SWE" });
    await expect(mergeJobs(job.id, job.id)).rejects.toThrow(/into itself/);
  });

  it("throws rather than half-merging when either record is gone", async () => {
    const job = await createJob({ title: "SWE" });
    await expect(mergeJobs(job.id, "missing")).rejects.toThrow(/no job with id missing/);
    await expect(mergeJobs("missing", job.id)).rejects.toThrow(/no job with id missing/);
    // The survivor was not written in either failed attempt.
    expect(await listJobs()).toHaveLength(1);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `crud.ts`'s change-signal emission and `backup.ts`'s bulk-import
 * coalescing (#760) — the storage-layer half of the fix; `library-channel.ts`
 * itself is unit-tested in `library-channel.test.ts`.
 *
 * Every listener here is a RAW `BroadcastChannel` opened directly on
 * `LIBRARY_CHANGE_CHANNEL_NAME`, not `onLibraryChange`. `crud.ts` posts
 * through `library-channel.ts`'s one shared module-scoped object, and
 * `onLibraryChange` listens through that SAME object — so a listener
 * registered via `onLibraryChange` would never see these posts (that
 * self-exclusion is the point, and is asserted directly in
 * `library-channel.test.ts`). A raw channel is the shape a second tab
 * actually has, and it's what lets this file observe crud.ts's emissions at
 * all.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  settleWithoutDelivery,
  waitForDelivery,
} from "./__test-utils__/library-channel-delivery.ts";
import { DB_NAME, closeDB } from "./db.ts";
import { LIBRARY_CHANGE_CHANNEL_NAME } from "./library-channel.ts";
import {
  putRecord,
  deleteRecord,
  clearStore,
  softDeleteRecord,
  runBatchedWrites,
} from "./crud.ts";
import { getAllRecords, getRecord } from "./crud.ts";
import { saveJob, archiveJobs } from "./jobs.ts";
import { importAll } from "./backup.ts";
import type { JobRecord, StorageExport } from "./types.ts";

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
});

/** Every archive in this file sweeps rows that really are still Interested,
 *  so the last-instant eligibility re-check `archiveJobs` requires (see its
 *  docblock) is the production one: `job-archive-sweep.ts`'s bucket test,
 *  spelled out here rather than imported because `src/lib/storage/` does not
 *  import upward. The one test that needs it to answer FALSE overrides it. */
const stillInterested = (job: JobRecord) => job.status === "interested";

/** Opens a raw listener on the change channel and hands back the messages it
 *  has seen plus a teardown. Sibling of `library-channel.test.ts`'s helper —
 *  duplicated rather than imported because it's the only thing this file
 *  needs from that pattern. */
function listenForChanges(): {
  received: { store: string }[];
  close: () => void;
} {
  const channel = new BroadcastChannel(LIBRARY_CHANGE_CHANNEL_NAME);
  const received: { store: string }[] = [];
  channel.addEventListener("message", (event) => {
    received.push((event as MessageEvent<{ store: string }>).data);
  });
  return { received, close: () => channel.close() };
}

function validJob(id: string): JobRecord {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: `Job ${id}`,
    company: "Acme",
    status: "interested",
  };
}

describe("crud.ts: writes post one change signal each, reads post none (#760)", () => {
  it("putRecord posts one message naming the store, carrying no record content or id", async () => {
    const listener = listenForChanges();
    try {
      const job = await putRecord<JobRecord>("jobs", {
        id: "job-1",
        title: "SWE",
        company: "Acme",
        status: "interested",
      });
      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
      // Sanity: the write really happened, so this isn't passing by accident.
      expect(job.id).toBe("job-1");
    } finally {
      listener.close();
    }
  });

  it("deleteRecord posts one message naming the store", async () => {
    await putRecord<JobRecord>("jobs", { id: "job-1", title: "SWE", company: "Acme", status: "interested" });
    const listener = listenForChanges();
    try {
      await deleteRecord("jobs", "job-1");
      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
    } finally {
      listener.close();
    }
  });

  it("clearStore posts one message naming the store", async () => {
    await putRecord<JobRecord>("jobs", { id: "job-1", title: "SWE", company: "Acme", status: "interested" });
    const listener = listenForChanges();
    try {
      await clearStore("jobs");
      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
    } finally {
      listener.close();
    }
  });

  it("softDeleteRecord posts one message when it actually tombstones a record", async () => {
    await putRecord<JobRecord>("jobs", { id: "job-1", title: "SWE", company: "Acme", status: "interested" });
    const listener = listenForChanges();
    try {
      const deleted = await softDeleteRecord("jobs", "job-1");
      expect(deleted).toBe(true);
      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
    } finally {
      listener.close();
    }
  });

  it("softDeleteRecord posts nothing on a no-op (already deleted / never existed)", async () => {
    const listener = listenForChanges();
    try {
      const deleted = await softDeleteRecord("jobs", "does-not-exist");
      expect(deleted).toBe(false);
      await settleWithoutDelivery();
      expect(listener.received).toEqual([]);
    } finally {
      listener.close();
    }
  });

  it("a read posts nothing", async () => {
    await putRecord<JobRecord>("jobs", { id: "job-1", title: "SWE", company: "Acme", status: "interested" });
    const listener = listenForChanges();
    try {
      await getAllRecords<JobRecord>("jobs");
      await settleWithoutDelivery();
      expect(listener.received).toEqual([]);
    } finally {
      listener.close();
    }
  });
});

describe("backup.ts: importAll coalesces a bulk write to one signal per store (#760)", () => {
  it("a large replace-mode import posts a bounded message count, not one per record", async () => {
    const jobCount = 50;
    const doc: StorageExport = {
      version: 1,
      exportedAt: Date.now(),
      resumes: [],
      jobs: Array.from({ length: jobCount }, (_, i) => validJob(`job-${i}`)),
    };

    const listener = listenForChanges();
    try {
      const counts = await importAll(doc, "replace");
      await waitForDelivery(() =>
        expect(listener.received.map((m) => m.store).sort()).toEqual([
          "jobs",
          "letters",
          "resumes",
        ]),
      );
      expect(counts.jobs).toBe(jobCount);
      // The whole point: NOT one message per record. Replace mode clears
      // all three stores regardless of what the document carries, so this
      // posts exactly one message per store (3) — bounded by the store
      // count, independent of how many of the 50 job records were written.
      expect(listener.received.length).toBeLessThan(jobCount);
    } finally {
      listener.close();
    }
  });

  it("a merge-mode import touching two stores posts at most one signal per store", async () => {
    await saveJob({ title: "Existing", status: "interested" });
    const doc: StorageExport = {
      version: 1,
      exportedAt: Date.now(),
      resumes: [],
      jobs: Array.from({ length: 10 }, (_, i) => validJob(`merge-job-${i}`)),
    };

    const listener = listenForChanges();
    try {
      await importAll(doc, "merge");
      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
      // Only `jobs` was touched by this document — `resumes`/`letters` see no
      // write at all in merge mode with an empty incoming list, so they post
      // nothing.
      expect(listener.received).toEqual([{ store: "jobs" }]);
    } finally {
      listener.close();
    }
  });
});

describe("jobs.ts: archiveJobs coalesces the bulk-archive sweep to one signal (#759)", () => {
  it("archiving many rows posts one message, not one per row", async () => {
    const rowCount = 20;
    const ids: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const job = await saveJob({ title: `Job ${i}`, company: "Acme", status: "interested" });
      ids.push(job.id);
    }

    const listener = listenForChanges();
    try {
      const archived = await archiveJobs(ids, {
        stillEligible: stillInterested,
      });
      expect(archived).toHaveLength(rowCount);
      expect(archived.every((j) => j.status === "archived")).toBe(true);
      // The whole point (#759, same shape as importAll above): NOT one
      // message per row.
      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
    } finally {
      listener.close();
    }
  });

  it("skips an id already gone rather than resurrecting it, and still posts nothing for zero live ids", async () => {
    const listener = listenForChanges();
    try {
      const archived = await archiveJobs(["never-existed"], {
        stillEligible: stillInterested,
      });
      expect(archived).toEqual([]);
      await settleWithoutDelivery();
      expect(listener.received).toEqual([]);
    } finally {
      listener.close();
    }
  });
});

describe("crud.ts: runBatchedWrites coalesces across CONCURRENT scopes, not just nested ones (#760)", () => {
  it("two overlapping batched calls still post one message per store", async () => {
    // The regression this file failed to catch. A flag-based "am I the
    // outermost call" scope only handles genuine call-stack nesting: two
    // independent calls whose lifetimes overlap both look outermost, so the
    // one that finishes first closes the scope and every remaining write of
    // the OTHER falls through to the unbatched branch — one message per
    // record again, which is precisely what #760's bounded-count bar exists
    // to rule out.
    //
    // Shapes deliberately mismatched, the way the two real callers are: a
    // short `resumes` write finishing early, and a longer `jobs` loop with an
    // await between rows (archiveJobs's shape) that keeps running after it.
    const listener = listenForChanges();
    try {
      // The SHORT call opens its scope FIRST and closes it FIRST. That order
      // is the whole repro: under a flag-based scope it is the one that looks
      // outermost, so its close tears the scope down while the long call is
      // still mid-loop, and every remaining `jobs` write falls through to the
      // unbatched branch.
      const rowCount = 5;
      const shortCall = runBatchedWrites(async () => {
        await putRecord("resumes", { id: "concurrent-resume" });
      });
      const longCall = runBatchedWrites(async () => {
        for (let i = 0; i < rowCount; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          await putRecord<JobRecord>("jobs", {
            id: `concurrent-job-${i}`,
            title: "SWE",
            company: "Acme",
            status: "interested",
          });
        }
      });

      await Promise.all([shortCall, longCall]);

      await waitForDelivery(() =>
        expect(listener.received.map((m) => m.store).sort()).toEqual([
          "jobs",
          "resumes",
        ]),
      );
      // Both stores, once each — never `rowCount` messages for `jobs`. The
      // short call's signal is deferred to the long call's close, which is
      // MORE coalescing than a per-call scope would give and is sound
      // because the message only ever means "re-read this store".
      expect(listener.received).toHaveLength(2);
    } finally {
      listener.close();
    }
  });

  it("a throwing write still flushes what landed and leaves the scope closed", async () => {
    // Exception safety, both halves. The `finally` must decrement even on a
    // throw: a counter stuck above zero would wedge every LATER emit into a
    // scope that never closes, so the next unbatched write would go silent
    // forever — a far worse failure than the one being fixed. And the writes
    // that did land before the throw are real changes other tabs must be
    // told about, so they flush on the way out rather than being discarded.
    const listener = listenForChanges();
    try {
      await expect(
        runBatchedWrites(async () => {
          await putRecord<JobRecord>("jobs", {
            id: "before-throw",
            title: "SWE",
            company: "Acme",
            status: "interested",
          });
          throw new Error("write failed");
        }),
      ).rejects.toThrow("write failed");

      await waitForDelivery(() =>
        expect(listener.received).toEqual([{ store: "jobs" }]),
      );
      expect(await getRecord<JobRecord>("jobs", "before-throw")).toBeDefined();

      // The scope really is closed: a plain unbatched write posts
      // immediately, which it could not do if the counter were still above
      // zero.
      await putRecord("resumes", { id: "after-throw" });
      await waitForDelivery(() =>
        expect(listener.received).toEqual([
          { store: "jobs" },
          { store: "resumes" },
        ]),
      );
    } finally {
      listener.close();
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-repost-sweep predicate tests — module scope, no storage. Covers the four
 * decisions the module's docblock makes: membership (not age) selects, the
 * Interested-bucket rule is the SAME one `job-archive-sweep.ts` enforces, every
 * member is taken rather than all-but-the-latest, and an id in a cluster that
 * is no longer in the library drops out instead of reaching storage.
 */

import { describe, it, expect } from "vitest";
import { repostedJobsToArchive } from "./job-repost-sweep.ts";
import type { JobRepostCluster } from "./job-repost-clusters.ts";
import type { JobRecord } from "./storage/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-05T00:00:00Z");

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    createdAt: NOW - 100 * DAY_MS,
    updatedAt: NOW - 100 * DAY_MS,
    title: "SWE",
    company: "Acme",
    status: "interested",
    ...over,
  };
}

function cluster(ids: string[], over: Partial<JobRepostCluster> = {}): JobRepostCluster {
  return {
    key: "acme::swe",
    company: "Acme",
    title: "SWE",
    ids,
    count: ids.length,
    ...over,
  };
}

describe("repostedJobsToArchive", () => {
  it("takes EVERY member of a cluster, not all-but-the-latest", () => {
    const jobs = [
      job({ id: "a", createdAt: NOW - 90 * DAY_MS }),
      job({ id: "b", createdAt: NOW - 40 * DAY_MS }),
      job({ id: "c", createdAt: NOW - 1 * DAY_MS }),
    ];
    // The newest member is swept with the rest: the user is clearing the role,
    // not de-duplicating it, and holding one back would leave the clutter the
    // sweep was reached for.
    expect(
      repostedJobsToArchive(jobs, [cluster(["a", "b", "c"])]).map((j) => j.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("leaves every pipeline bucket alone, however deep in a cluster", () => {
    const jobs = [
      job({ id: "a" }),
      job({ id: "b", status: "applied" }),
      job({ id: "c", status: "interviewing" }),
      job({ id: "d", status: "offer" }),
      job({ id: "e", status: "rejected" }),
    ];
    // The guarantee the confirm dialog states. Cluster membership never
    // overrides hand-built pipeline state.
    expect(
      repostedJobsToArchive(jobs, [cluster(["a", "b", "c", "d", "e"])]).map(
        (j) => j.id,
      ),
    ).toEqual(["a"]);
  });

  it("re-running it is a no-op — an already-archived member never matches", () => {
    const jobs = [job({ id: "a", status: "archived" }), job({ id: "b" })];
    const first = repostedJobsToArchive(jobs, [cluster(["a", "b"])]);
    expect(first.map((j) => j.id)).toEqual(["b"]);

    const after = jobs.map((j) =>
      j.id === "b" ? { ...j, status: "archived" as const } : j,
    );
    expect(repostedJobsToArchive(after, [cluster(["a", "b"])])).toEqual([]);
  });

  it("selects on membership alone — an unreadable createdAt is swept, not spared", () => {
    // The opposite direction from `job-archive-sweep.ts`, and deliberately so:
    // no date is consulted here, and an unreadable capture time is what put the
    // group in a cluster in the first place.
    const jobs = [job({ id: "a", createdAt: Number.NaN as unknown as number })];
    expect(repostedJobsToArchive(jobs, [cluster(["a"])]).map((j) => j.id)).toEqual([
      "a",
    ]);
  });

  it("ignores an unclustered job however old, and a cluster id no longer in the library", () => {
    const jobs = [job({ id: "a" }), job({ id: "loner", createdAt: 0 })];
    // "gone" was removed between the sweep and this call; it drops out rather
    // than reaching storage as a lookup that misses.
    expect(
      repostedJobsToArchive(jobs, [cluster(["a", "gone"])]).map((j) => j.id),
    ).toEqual(["a"]);
  });

  it("returns nothing when there are no clusters", () => {
    expect(repostedJobsToArchive([job({ id: "a" })], [])).toEqual([]);
  });

  it("spans clusters, in the library's own order", () => {
    const jobs = [
      job({ id: "b1", company: "Beta", title: "PM" }),
      job({ id: "a1" }),
      job({ id: "b2", company: "Beta", title: "PM" }),
      job({ id: "a2" }),
    ];
    expect(
      repostedJobsToArchive(jobs, [
        cluster(["a1", "a2"]),
        cluster(["b1", "b2"], { key: "beta::pm", company: "Beta", title: "PM" }),
      ]).map((j) => j.id),
    ).toEqual(["b1", "a1", "b2", "a2"]);
  });
});

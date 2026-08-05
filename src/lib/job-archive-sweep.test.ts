// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-archive-sweep predicate tests (#759) — module scope, no storage. Covers
 * the four decisions the issue names: `createdAt` (not `datePosted`) as the
 * cutoff field, Interested-bucket-only scope, and an unreadable `createdAt`
 * being spared rather than swept.
 */

import { describe, it, expect } from "vitest";
import {
  isSweepable,
  isSweepableBucket,
  jobsToArchive,
} from "./job-archive-sweep.ts";
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

describe("isSweepableBucket", () => {
  // The half `storage/jobs.ts`'s `archiveJobs` re-evaluates against each row
  // the instant before writing it, so what matters here is that it answers on
  // the bucket ALONE — the same answer at confirm time and a minute later,
  // whatever the row's age.
  it("accepts an Interested row and every alias that buckets to Interested", () => {
    for (const status of ["interested", "saved", "scouted", "shared"]) {
      expect(
        isSweepableBucket(job({ status: status as JobRecord["status"] })),
      ).toBe(true);
    }
  });

  it("rejects every pipeline bucket the confirm dialog promises to leave alone", () => {
    for (const status of ["applied", "interviewing", "offer", "rejected", "withdrawn"]) {
      expect(
        isSweepableBucket(job({ status: status as JobRecord["status"] })),
      ).toBe(false);
    }
  });

  it("rejects a row already archived, so a re-run is a no-op", () => {
    expect(isSweepableBucket(job({ status: "archived" }))).toBe(false);
  });

  it("carries no clock — age cannot change its answer", () => {
    const fresh = job({ createdAt: NOW });
    const ancient = job({ createdAt: NOW - 9999 * DAY_MS });
    expect(isSweepableBucket(fresh)).toBe(true);
    expect(isSweepableBucket(ancient)).toBe(true);
  });
});

describe("isSweepable", () => {
  it("sweeps an Interested job whose createdAt is older than the cutoff", () => {
    const j = job({ createdAt: NOW - 40 * DAY_MS });
    expect(isSweepable(j, 30, NOW)).toBe(true);
  });

  it("does not sweep a job exactly at the cutoff (strictly older, not at-or-older)", () => {
    const j = job({ createdAt: NOW - 30 * DAY_MS });
    expect(isSweepable(j, 30, NOW)).toBe(false);
  });

  it("does not sweep a job newer than the cutoff", () => {
    const j = job({ createdAt: NOW - 5 * DAY_MS });
    expect(isSweepable(j, 30, NOW)).toBe(false);
  });

  it("reads createdAt, not datePosted — a row with no capture date is still eligible", () => {
    const j = job({ createdAt: NOW - 40 * DAY_MS, datePosted: undefined });
    expect(isSweepable(j, 30, NOW)).toBe(true);
  });

  it.each(["applied", "interviewing", "offer", "rejected"] as const)(
    "never sweeps a %s job, however old",
    (status) => {
      const j = job({ status, createdAt: NOW - 400 * DAY_MS });
      expect(isSweepable(j, 30, NOW)).toBe(false);
    },
  );

  it("a job already archived never matches (no-op, not an exclusion to special-case)", () => {
    const j = job({ status: "archived", createdAt: NOW - 400 * DAY_MS });
    expect(isSweepable(j, 30, NOW)).toBe(false);
  });

  it.each(["saved", "scouted", "shared"])(
    "sweeps a %s row — it buckets as Interested (#744)",
    (status) => {
      const j = job({
        status: status as JobRecord["status"],
        createdAt: NOW - 40 * DAY_MS,
      });
      expect(isSweepable(j, 30, NOW)).toBe(true);
    },
  );

  it("spares a job with no createdAt at all — unreadable is withheld, not swept", () => {
    const j = job({ createdAt: undefined });
    expect(isSweepable(j, 30, NOW)).toBe(false);
  });

  it("spares a job whose createdAt is not a finite number", () => {
    for (const bad of [Number.NaN, Infinity, "yesterday" as unknown as number, null]) {
      const j = job({ createdAt: bad as unknown as number });
      expect(isSweepable(j, 30, NOW)).toBe(false);
    }
  });
});

describe("jobsToArchive", () => {
  it("returns exactly the sweepable subset, preserving order", () => {
    const keep = job({ title: "Keep — applied", status: "applied", createdAt: NOW - 400 * DAY_MS });
    const sweep1 = job({ title: "Sweep 1", createdAt: NOW - 60 * DAY_MS });
    const tooNew = job({ title: "Too new", createdAt: NOW - 1 * DAY_MS });
    const sweep2 = job({ title: "Sweep 2", createdAt: NOW - 90 * DAY_MS });

    const result = jobsToArchive([keep, sweep1, tooNew, sweep2], 30, NOW);
    expect(result.map((j) => j.title)).toEqual(["Sweep 1", "Sweep 2"]);
  });

  it("returns an empty array when nothing matches", () => {
    const j = job({ createdAt: NOW - 1 * DAY_MS });
    expect(jobsToArchive([j], 30, NOW)).toEqual([]);
  });
});

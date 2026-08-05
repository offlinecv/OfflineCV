// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-archive-sweep — the predicate behind "archive jobs older than X days"
 * (#759). Pure, zero-storage: it answers "does this job belong in the
 * sweep?" and nothing else. `JobArchiveSweepDialog` calls it for the live
 * preview count and `job-tracker.ts`'s `archiveInterestedOlderThan` calls the
 * SAME function for the write — one predicate, so the number a user confirms
 * can never disagree with the rows the sweep actually touches. Sibling of
 * `job-status-bucket.ts` and `job-duplicates.ts`, testable at module scope
 * for the same reason.
 *
 * ## What the cutoff reads
 *
 * `createdAt` — when the row entered THIS library — never `datePosted`. A row
 * that arrived without a capture has no `datePosted` at all, and those are
 * exactly the rows a sweep exists to clear; a `datePosted` rule would
 * silently skip its whole target population and archive only the postings
 * the user typed in by hand. Every stored job carries `createdAt` by contract
 * (`putRecord` stamps it), so this is the one date field a sweep can rely on.
 *
 * ## What it may touch
 *
 * Only rows whose {@link jobStatusBucket} is `"interested"`. `applied` /
 * `interviewing` / `offer` / `rejected` carry pipeline state the user built
 * by hand, and a sweep that could reach them is a sweep nobody would run
 * twice. `archived` is already the destination, so a row already there
 * simply never matches — a no-op this module doesn't have to special-case.
 *
 * That bucket rule is exported on its own as {@link isSweepableBucket},
 * because it is checked TWICE at different moments: once here, over the
 * array the preview counted, and once again inside `storage/jobs.ts`'s
 * `archiveJobs` against the row as it stands the instant before its write
 * (see that function's docblock for the concurrent-writer case that makes
 * the second check load-bearing). One exported predicate rather than two
 * spellings, so the guarantee the confirm dialog states — pipeline rows are
 * never touched — cannot drift between the two places that enforce it.
 *
 * The AGE half is deliberately not re-checked at write time. The cutoff is
 * the user's decision, taken at confirm against a clock read this module was
 * given; re-deriving it inside the write would introduce a second clock read
 * and with it a second way for the preview and the write to disagree.
 *
 * ## An unreadable `createdAt` is SPARED, not swept
 *
 * A record can arrive from a backup predating any field (same bar as
 * `job-duplicates.ts`), so `createdAt` is read as `unknown` and checked with
 * `Number.isFinite` rather than trusted from the type. An unreadable value
 * degrades to "not old enough to sweep" — the withholding direction, not the
 * acting one. Sweeping a record this module cannot date is the one-way
 * mistake: the write bumps `updatedAt` and overwrites whatever vocabulary
 * (`saved` / `scouted`) the row arrived with, and reversing it is a second
 * full write, not a rollback (see `job-tracker.ts`'s
 * `archiveInterestedOlderThan` docblock). Leaving an undateable row in
 * Interested costs nothing but a repeat sweep once it can be read.
 */

import { jobStatusBucket } from "./job-status-bucket.ts";
import type { JobRecord } from "./storage/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A finite `createdAt` if the field really is one, else `NaN` — every
 *  comparison below answers `false` to `NaN`, which is the "can't date it,
 *  don't touch it" reading described above. */
function createdAtMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Is `job` in a bucket a sweep may touch at all — regardless of its age?
 *
 * The half of {@link isSweepable} that carries no clock, which is exactly why
 * it is separable: it can be re-evaluated at any later moment and still mean
 * the same thing. `archiveInterestedOlderThan` hands it to `archiveJobs` as
 * the last-instant eligibility check on each row it is about to write; see
 * this module's docblock.
 */
export function isSweepableBucket(job: JobRecord): boolean {
  return jobStatusBucket(job.status) === "interested";
}

/**
 * Does `job` belong in an archive sweep at this cutoff? `now` is injectable
 * for tests; production callers rely on the default.
 */
export function isSweepable(
  job: JobRecord,
  cutoffDays: number,
  now: number = Date.now(),
): boolean {
  if (!isSweepableBucket(job)) return false;
  const createdAt = createdAtMs(job.createdAt);
  if (!Number.isFinite(createdAt)) return false;
  return now - createdAt > cutoffDays * DAY_MS;
}

/**
 * Every job in `jobs` an archive sweep at this cutoff would touch, in the
 * caller's order. The one function both the preview count and the write use
 * — see the module docblock.
 */
export function jobsToArchive(
  jobs: readonly JobRecord[],
  cutoffDays: number,
  now: number = Date.now(),
): JobRecord[] {
  return jobs.filter((job) => isSweepable(job, cutoffDays, now));
}

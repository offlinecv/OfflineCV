// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-tracker — domain layer over the IndexedDB job store (#323, `storage/jobs`).
 *
 * The store (#321) manages id + timestamps and treats the record as opaque; this
 * module owns the tracked-job semantics the tracker UI needs: the pinned
 * {@link JobRecord} shape, a sensible status default, and the resume-link
 * lifecycle (link, unlink, and the graceful-degrade clear when a linked resume
 * is deleted — the job is kept, only its dangling link is dropped).
 *
 * Sibling of `resume-library.ts`; both sit between their `src/hooks` façade and
 * `src/lib/storage`, and neither imports the parser graph.
 */

import {
  saveJob,
  getJob,
  getAllJobs,
  deleteJob,
  archiveJobs,
  lettersForJob,
  saveLetter,
} from "./storage/index.ts";
import { mergeJobRecords } from "./job-merge.ts";
import { isSweepableBucket, jobsToArchive } from "./job-archive-sweep.ts";
import { repostedJobsToArchive } from "./job-repost-sweep.ts";
import type { JobRepostCluster } from "./job-repost-clusters.ts";
import type { JobRecord, JobStatus } from "./storage/index.ts";

/** Fields a caller supplies when creating a tracked job. `status` defaults to
 *  `"interested"`; id + timestamps are managed by the store. */
export interface NewJobInput {
  title: string;
  company?: string;
  url?: string;
  notes?: string;
  status?: JobStatus;
  resumeId?: string;
  jdText?: string;
  matchResult?: unknown;
}

/**
 * The editable subset of a job — everything a user can change from the tracker.
 *
 * An OMITTED key leaves the field untouched. An explicit `undefined` CLEARS it:
 * `updateJob` spreads `{ ...existing, ...patch }`, and a spread copies an own
 * property even when its value is `undefined`. That is not an accident to be
 * tidied away — {@link unlinkResume} is built on it (`{ resumeId: undefined }`
 * is how a link gets dropped). Pass an empty string to blank an optional text
 * field.
 */
export type JobPatch = Partial<
  Pick<
    JobRecord,
    "title" | "company" | "url" | "notes" | "status" | "resumeId"
  >
>;

/** All tracked jobs, most-recently-updated first (the tracker's default order).
 *  Grouping / filtering by status is a view concern left to the UI. */
export async function listJobs(): Promise<JobRecord[]> {
  const jobs = await getAllJobs();
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getJobById(id: string): Promise<JobRecord | undefined> {
  return getJob(id);
}

/** Create a tracked job. Blank company is allowed (the user can fill it later);
 *  status defaults to `"interested"`. Returns the stored record (with id +
 *  timestamps). */
export function createJob(input: NewJobInput): Promise<JobRecord> {
  return saveJob({
    title: input.title,
    company: input.company ?? "",
    url: input.url,
    notes: input.notes,
    status: input.status ?? "interested",
    resumeId: input.resumeId,
    jdText: input.jdText,
    matchResult: input.matchResult,
  });
}

/** Apply a partial update to an existing job, preserving every field the patch
 *  doesn't mention (and `createdAt`, via the store). Throws if the job is gone. */
export async function updateJob(
  id: string,
  patch: JobPatch,
): Promise<JobRecord> {
  const existing = await getJob(id);
  if (!existing) throw new Error(`job-tracker: no job with id ${id}`);
  return saveJob({ ...existing, ...patch, id });
}

/** Move a job to a new lifecycle status. */
export function setJobStatus(id: string, status: JobStatus): Promise<JobRecord> {
  return updateJob(id, { status });
}

/** Link a job to the saved resume version used for it. */
export function linkResume(id: string, resumeId: string): Promise<JobRecord> {
  return updateJob(id, { resumeId });
}

/** Drop a job's resume link (user action), keeping the job. */
export function unlinkResume(id: string): Promise<JobRecord> {
  return updateJob(id, { resumeId: undefined });
}

export function removeJob(id: string): Promise<void> {
  return deleteJob(id);
}

/**
 * Fold one tracked job into another (#746) — the write half of the merge whose
 * field rules live in `job-merge.ts`. Returns the surviving record.
 *
 * **Only ever called from an explicit user click.** Nothing infers a merge:
 * `job-duplicates.ts` reports evidence and stops there, because under-merging
 * leaves a duplicate the user can delete while over-merging destroys a record,
 * and this build has no evidence source strong enough to overrule that.
 *
 * ## The order of the three writes is the recovery story
 *
 * 1. **The survivor is written first**, so the merged fields and both URLs are
 *    durable before anything is destroyed. Every failure after this point
 *    leaves an under-merge — two records, one of which already carries
 *    everything — which the user can see and redo. The reverse order can lose
 *    the absorbed record's fields outright.
 * 2. **Its letters are reparented next**, before the delete rather than after,
 *    because `deleteJob` CASCADES to a job's cover letters (`storage/jobs.ts`)
 *    and a merge that silently destroyed the letters the user wrote for this
 *    posting would be exactly the over-merge this feature is built to avoid.
 *    `touch: false`: the user merged two jobs, they did not edit a letter, and
 *    stamping `updatedAt` would reorder a drafts list sorted by it.
 * 3. **The absorbed record is deleted through the normal path**, so it
 *    TOMBSTONES (#730). A hard delete would be indistinguishable from "never
 *    existed" to any second holder of this library, which would hand the
 *    duplicate straight back on the next restore or sync.
 */
export async function mergeJobs(
  survivorId: string,
  absorbedId: string,
): Promise<JobRecord> {
  if (survivorId === absorbedId) {
    throw new Error(`job-tracker: cannot merge job ${survivorId} into itself`);
  }
  const [survivor, absorbed] = await Promise.all([
    getJob(survivorId),
    getJob(absorbedId),
  ]);
  if (!survivor) throw new Error(`job-tracker: no job with id ${survivorId}`);
  if (!absorbed) throw new Error(`job-tracker: no job with id ${absorbedId}`);

  const merged = await saveJob({
    ...mergeJobRecords(survivor, absorbed),
    id: survivorId,
  });

  for (const letter of await lettersForJob(absorbedId)) {
    await saveLetter({ ...letter, jobId: survivorId }, { touch: false });
  }
  await removeJob(absorbedId);

  return merged;
}

/**
 * Graceful degrade for a deleted resume (#323 AC): clear the link from every
 * job that pointed at `resumeId`, keeping the jobs. Idempotent and cheap — a
 * no-op when nothing linked it. Returns the number of jobs whose link was
 * cleared. Call this from the resume-delete path.
 */
export async function clearResumeLink(resumeId: string): Promise<number> {
  const jobs = await getAllJobs();
  const linked = jobs.filter((j) => j.resumeId === resumeId);
  for (const job of linked) {
    // `touch: false` — the user deleted a RESUME, not these jobs. Stamping
    // `updatedAt` would float every job that merely referenced it to the top of
    // a list sorted most-recently-updated-first.
    await saveJob({ ...job, resumeId: undefined, id: job.id }, { touch: false });
  }
  return linked.length;
}

/**
 * Sweep dangling resume links against the set of resume ids that still exist —
 * a belt-and-suspenders reconcile for links orphaned by any delete path the
 * explicit {@link clearResumeLink} call missed. Returns the number of jobs
 * repaired.
 *
 * Called from `useResumeLibrary`'s `importBackup`, after a merge-mode JSON
 * import writes: merge upserts by id and never deletes, but an incoming job
 * can carry a resumeId neither this device nor the imported file has, and
 * nothing else clears that dangling link (#547). Replace-mode import doesn't
 * call this — see the comment at that call site for why.
 */
export async function reconcileResumeLinks(
  existingResumeIds: ReadonlySet<string>,
): Promise<number> {
  const jobs = await getAllJobs();
  const dangling = jobs.filter(
    (j) => j.resumeId !== undefined && !existingResumeIds.has(j.resumeId),
  );
  for (const job of dangling) {
    // Housekeeping, not a user edit — see `clearResumeLink`.
    await saveJob({ ...job, resumeId: undefined, id: job.id }, { touch: false });
  }
  return dangling.length;
}

/** Longest derived title we keep — past this a JD's first line is prose, not a
 *  title, and the row would just truncate. */
const MAX_DERIVED_TITLE = 80;

/**
 * Best-effort job title for a pasted JD: its first non-empty line, which is the
 * posting title in the overwhelming majority of copy-pasted descriptions.
 *
 * Deliberately dumb and never-fail: this is a *seed* for a field the user can
 * rename inline in the tracker, not an extraction step. A too-long or empty
 * first line falls back to `"Untitled job"` rather than guessing further — we
 * never scrape or infer beyond what the user pasted (#323 non-goal).
 */
export function deriveJobTitleFromJd(jdText: string): string {
  const firstLine = jdText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined || firstLine.length > MAX_DERIVED_TITLE) {
    return "Untitled job";
  }
  return firstLine;
}

/**
 * "Save this job" from the JD-match flow (#323 AC): create a tracked job that
 * carries the pasted JD text and the match result the user just ran, so a
 * moment-in-time match becomes a tracked application in one step.
 */
export function createTrackedJobFromMatch(input: {
  title: string;
  company?: string;
  url?: string;
  jdText: string;
  matchResult?: unknown;
  resumeId?: string;
}): Promise<JobRecord> {
  return createJob({ ...input, status: "interested" });
}

/**
 * Bulk-archive sweep (#759): every job in `jobs` whose bucket is Interested
 * and whose `createdAt` is more than `cutoffDays` days old becomes
 * `"archived"`. Returns the count actually archived.
 *
 * `jobs` is a PARAMETER, not a fresh `getAllJobs()` read, and that is the
 * point: the caller (`useJobTracker.archiveOlderThan`) computes its live
 * preview count with `jobsToArchive` over this exact same in-memory array,
 * and threading it through here — rather than re-listing from storage —
 * means the set this call SELECTS is exactly the set the user was counting.
 * No difference in policy, no re-derived cutoff, no second clock read.
 *
 * The count this returns can still come out BELOW that preview, and only for
 * one reason: `archiveJobs` re-checks each row's bucket against storage
 * immediately before writing it, and skips one that stopped being Interested
 * while the sweep was running (see that function's docblock). Selection and
 * preview agree by construction; a row someone else moved to Applied
 * mid-sweep is deliberately not written, and the returned count says so
 * rather than counting a write that did not happen. `isSweepableBucket` —
 * the same predicate `jobsToArchive` filtered on — is what performs that
 * re-check, so the two can never disagree about what Interested means.
 *
 * One-way: every swept row's status becomes the literal string `"archived"`,
 * which overwrites whatever vocabulary (`saved` / `scouted`) a syncing
 * producer stored it with — `job-status-bucket.ts`'s whole reason for
 * existing is that such a rewrite destroys meaning a sync would carry back.
 * The confirm dialog states this; this function does not re-litigate it.
 *
 * The actual writes are `archiveJobs` (`storage/jobs.ts`), which coalesces
 * the cross-tab change signal to one message regardless of how many rows
 * this call touches (#760) — see that function's docblock.
 */
export async function archiveInterestedOlderThan(
  jobs: readonly JobRecord[],
  cutoffDays: number,
  now: number = Date.now(),
): Promise<number> {
  const toArchive = jobsToArchive(jobs, cutoffDays, now);
  if (toArchive.length === 0) return 0;
  const archived = await archiveJobs(
    toArchive.map((job) => job.id),
    { stillEligible: isSweepableBucket },
  );
  return archived.length;
}

/**
 * Repost sweep: every Interested job that belongs to one of `clusters` becomes
 * `"archived"`. Returns the count actually archived.
 *
 * Every paragraph of {@link archiveInterestedOlderThan}'s docblock applies
 * verbatim — `jobs` is a parameter so selection and preview agree by
 * construction, the returned count can come out below the preview only because
 * `archiveJobs` re-judges each row against storage immediately before writing
 * it, the status rewrite is one-way over a synced row's own vocabulary, and the
 * cross-tab change signal is coalesced to one message. The two functions differ
 * in exactly one line: which pure selector chooses the rows.
 *
 * `clusters` is a parameter for the same reason `jobs` is. The caller's list is
 * `useJobRepostClusters`' derived-on-view sweep, which the user has been shown
 * a count against; re-deriving it here would be a second grouping pass over a
 * possibly-different library and a second chance to disagree with the number on
 * the confirm button.
 */
export async function archiveRepostedRoles(
  jobs: readonly JobRecord[],
  clusters: readonly JobRepostCluster[],
): Promise<number> {
  const toArchive = repostedJobsToArchive(jobs, clusters);
  if (toArchive.length === 0) return 0;
  const archived = await archiveJobs(
    toArchive.map((job) => job.id),
    { stillEligible: isSweepableBucket },
  );
  return archived.length;
}

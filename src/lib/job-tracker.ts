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

import { saveJob, getJob, getAllJobs, deleteJob } from "./storage/jobs.ts";
import type { JobRecord, JobStatus } from "./storage/types.ts";

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
 * explicit {@link clearResumeLink} call missed (e.g. a merge-mode import that
 * dropped a resume). Returns the number of jobs repaired.
 *
 * NOTE: staged for #547 — no production caller yet. The delete path uses
 * `clearResumeLink`, and the JSON import path (`storage/backup.ts`) that would
 * orphan links isn't wired to any UI. This is called from the import flow once
 * that lands; until then it's exercised only by its unit test.
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

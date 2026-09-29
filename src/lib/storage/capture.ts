// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The capture entry point (#693) — how a job record written by something other
 * than this app's own UI reaches the `jobs` store, and the reference
 * implementation of `docs/job-capture-contract.md`.
 *
 * Two responsibilities the import path does not have:
 *
 *  - **Convergence.** A producer does not know what this device already holds,
 *    so it cannot avoid duplicates by checking. It avoids them by DERIVING the
 *    id from the posting URL (`job-url.ts`), which makes two captures of one
 *    posting the same key and lets `putRecord`'s upsert collapse them.
 *  - **Not clobbering the user.** A re-capture is a producer telling us about a
 *    posting, not a user editing their application. `status`, `notes` and
 *    `resumeId` are the user's; `title`, `company`, `url`, `jdText`,
 *    `matchResult` and `capture` are the producer's. A re-capture that reset an
 *    "applied" job to "interested" would be worse than the duplicate it fixed.
 *    `aliasUrls` is neither: it is unioned, because an alias is additive and
 *    the stored ones are usually a merge the user performed (#746).
 *
 * Lib-only and browser-agnostic: no `fetch`, no extension API, no UI. The
 * transport that carries a record here (an extension message port, a paste, a
 * file) is the caller's problem — this module's contract is `unknown` in, a
 * validated record or a list of reasons out.
 *
 * NOTE: staged for the extension — no production caller yet. Nothing in this
 * build captures a job from outside its own UI: the tracker and the JD-match
 * "save this job" button are typechecked against `JobRecord` and write through
 * `job-tracker.ts`, and the backup import path has its own entry point
 * (`backup.ts`). The MV3 capture extension that calls this is tracked outside
 * this repo, deferred out of the batch that shipped
 * `docs/job-capture-contract.md`. Until it lands
 * this module is exercised only by `capture.test.ts` and `storage.test.ts`; it
 * ships now, and is exported from the storage barrel, so the extension imports
 * the ownership merge below rather than reimplementing it against the store.
 */

import { getJob, saveJob } from "./jobs.ts";
import { validateJobRecord, type JobRecordIssue } from "./job-record-contract.ts";
import { dedupeCanonicalUrls, deriveJobId } from "./job-url.ts";
import type { JobRecord } from "./types.ts";

export type JobCaptureResult =
  | {
      ok: true;
      record: JobRecord;
      /** False when this capture updated a record that was already here — the
       *  convergence signal a caller shows as "already saved". */
      created: boolean;
      warnings: JobRecordIssue[];
    }
  | { ok: false; reasons: JobRecordIssue[] };

/** One record's `aliasUrls` as strings, defensively — see the call site. */
function aliasList(job: JobRecord): string[] {
  const entries = Array.isArray(job.aliasUrls) ? job.aliasUrls : [];
  return entries.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Resolve the id for a candidate capture.
 *
 * Precedence: an explicit non-empty `id` the producer supplied, then the URL
 * derivation, then a fresh UUID. A producer with a better identity than the URL
 * (its own posting key) may state it; one without a URL gets a UUID and simply
 * does not converge, which the contract document says out loud rather than
 * pretending to dedupe on title.
 */
function resolveCaptureId(input: Record<string, unknown>): string {
  if (typeof input.id === "string" && input.id.length > 0) return input.id;
  if (typeof input.url === "string") {
    const derived = deriveJobId(input.url);
    if (derived !== undefined) return derived;
  }
  return crypto.randomUUID();
}

/**
 * Validate an externally-authored job record and write it, converging on any
 * record that already carries the same derived id.
 *
 * Producer-supplied `createdAt` / `updatedAt` are dropped: the store owns them,
 * a re-capture must not float a job to the top of a list sorted
 * most-recently-updated-first, and a producer with a wrong clock would
 * otherwise bury or float its own captures. Hence `touch: false` — a brand-new
 * capture still gets `now` from `putRecord`, an update keeps what was there.
 *
 * `deletedAt` is dropped for a different reason (#730): a capture is a producer
 * saying *this posting exists*, which is not a claim it can make about whether
 * the user deleted their record of it. A producer that wants to replicate a
 * deletion is doing replication, not capture, and goes through the store's own
 * delete path.
 *
 * ## Capturing a posting the user deleted REVIVES it
 *
 * `getJob` reads a tombstoned job as absent, so the merge below sees no
 * existing record, the write replaces the tombstone with a live record, and the
 * result reports `created: true`. That is deliberate and it is also what this
 * function already did when deletion was a hard delete — the user gets the same
 * behaviour from the same action, and the tombstone's only job was to stop a
 * *replica* from resurrecting the record behind their back, not to stop them
 * saving the posting again. `createdAt` still survives from the tombstone, so a
 * revived job keeps the date it was first saved.
 */
export async function captureJob(input: unknown): Promise<JobCaptureResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reasons: ["A captured job must be a plain JSON object."] };
  }
  const candidate = input as Record<string, unknown>;
  const proposed: Record<string, unknown> = { ...candidate, id: resolveCaptureId(candidate) };
  delete proposed.createdAt;
  delete proposed.updatedAt;
  delete proposed.deletedAt;

  const validation = validateJobRecord(proposed);
  if (!validation.ok) return validation;

  const merged: JobRecord = { ...validation.record };
  const existing = await getJob(merged.id);
  if (existing) {
    // The three user-owned fields. `??`, not `||`: notes the user cleared to
    // `""` is a choice, and only a genuinely absent value falls through to
    // whatever the producer sent.
    merged.status = existing.status;
    merged.notes = existing.notes ?? merged.notes;
    merged.resumeId = existing.resumeId ?? merged.resumeId;

    // `aliasUrls` is neither producer-owned nor user-owned: it is UNIONED, and
    // it is the only field here that is (#746). An alias is additive by
    // definition — recording one never rewrites anything — so the two sides
    // cannot conflict. The direction that matters is what a plain
    // producer-wins would do: the aliases on the stored record are usually the
    // ones the USER put there by merging two rows, and a re-capture that
    // omitted the field would silently undo that merge, which is the same
    // family of loss as resetting an `interviewing` job to `interested`.
    // `Array.isArray`, not `?? []`: the store's write path is permissive, so
    // the stored value is only as typed as whatever wrote it, and spreading a
    // non-iterable throws.
    const aliasUrls = dedupeCanonicalUrls(
      [...aliasList(existing), ...aliasList(merged)],
      merged.url === undefined ? [] : [merged.url],
    );
    if (aliasUrls.length > 0) merged.aliasUrls = aliasUrls;
    else delete merged.aliasUrls;
  }

  const record = await saveJob(merged, { touch: false });
  return { ok: true, record, created: existing === undefined, warnings: validation.warnings };
}

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
import { deriveJobId } from "./job-url.ts";
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
 */
export async function captureJob(input: unknown): Promise<JobCaptureResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reasons: ["A captured job must be a plain JSON object."] };
  }
  const candidate = input as Record<string, unknown>;
  const proposed: Record<string, unknown> = { ...candidate, id: resolveCaptureId(candidate) };
  delete proposed.createdAt;
  delete proposed.updatedAt;

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
  }

  const record = await saveJob(merged, { touch: false });
  return { ok: true, record, created: existing === undefined, warnings: validation.warnings };
}

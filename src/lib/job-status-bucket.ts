// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-status-bucket — the job tracker's DISPLAY vocabulary (#744). Zero-dep
 * beyond the stored vocabulary itself, sibling of `job-tracker.ts`, and testable
 * at module scope.
 *
 * The stored vocabulary is open by contract: `job-record-contract.ts`'s
 * `isStatusLike` accepts any string and preserves it verbatim, precisely so a
 * record written by another producer keeps whatever that producer meant. The
 * tracker then grouped on that literal string, so a synced library rendered
 * `Saved`, `Scouted`, `Shared` and `Interested` as four top-level sections —
 * which a user reads as four different things when they are one stage of a job
 * search. Those three differ by how the job ARRIVED (a manual save, a job
 * alert, a sponsor share), not by where it sits in the pipeline, and the tracker
 * renders pipeline stages.
 *
 * So the mapping happens at VIEW time and never at write time. That distinction
 * is the whole point of the module: rewriting a stored `shared` to `interested`
 * is not a display change, it is a write that destroys the meaning the producing
 * system attached to the row and that a sync would carry back. **Nothing here
 * returns a value anyone should persist.** {@link jobStatusBucket} answers only
 * "which section does this row render under"; the row's badge still prints the
 * literal status through `jobStatusLabel`.
 *
 * A status this module cannot map still buckets as ITSELF, which keeps the
 * fail-loud escape hatch `JobTracker` and `JobTrackerStatusGroup` each document.
 * This narrows what counts as unrecognised; it does not remove the hatch.
 */

import { isKnownStatus } from "./storage/index.ts";
import type { JobStatus } from "./storage/index.ts";

/**
 * Statuses outside this build's lifecycle that name the same STAGE as one
 * inside it.
 *
 * These are Recruidea's (`saved_jobs.status`), whose vocabulary is a superset of
 * ours: `saved` / `scouted` / `shared` all say a job is on the list and not
 * applied to yet, and `withdrawn` closes an application the same way `rejected`
 * does — just from the other side.
 *
 * A `Map`, not an object literal, because the key is untrusted imported data: an
 * object literal answers `"toString"` with a function off `Object.prototype`,
 * which would hand the tracker a bucket key that is not even a string.
 *
 * Adding a row here is a decision about MEANING, not spelling. Two statuses
 * belong in one bucket only when the user's next action on both is the same —
 * an alias that merely *looks* similar hides a distinction instead of a
 * duplicate.
 */
const BUCKET_OF_ALIAS = new Map<string, JobStatus>([
  ["saved", "interested"],
  ["scouted", "interested"],
  ["shared", "interested"],
  ["withdrawn", "rejected"],
]);

/**
 * The section a stored status renders under.
 *
 * A status this build's lifecycle knows is its own bucket; a known alias maps to
 * the lifecycle status it means; anything else buckets as itself, so a status
 * outside both vocabularies still gets a section labelled with its literal
 * string.
 *
 * {@link isKnownStatus} is consulted FIRST so the canonical vocabulary can never
 * be shadowed by an alias: were a future `JobStatus` to adopt `saved`, the stale
 * row here would stop mattering rather than silently redirect it.
 *
 * Matching is exact — `"Shared"` is not `"shared"`. Case-folding would be a
 * guess about a producer nobody has seen, and the cost of guessing wrong is an
 * unrelated status quietly folded into a bucket it does not belong in; the cost
 * of not guessing is one extra section, which is exactly the fail-loud state.
 *
 * Never store the return value — see this module's docblock.
 */
export function jobStatusBucket(status: string): string {
  if (isKnownStatus(status)) return status;
  return BUCKET_OF_ALIAS.get(status) ?? status;
}

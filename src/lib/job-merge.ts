// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-merge — what one tracked job looks like after another is folded into it
 * (#746). Pure and storage-free: it takes two records and returns the record
 * that should survive. `job-tracker.ts`'s `mergeJobs` is what writes it, and
 * what tombstones the other one.
 *
 * ## Lossy in exactly one direction
 *
 * A merge is the one action in the tracker that destroys a record, so every
 * rule here resolves toward keeping text the user wrote:
 *
 *  - **Notes are concatenated, never overwritten.** Two paragraphs about one
 *    application are both about that application.
 *  - **A field the survivor lacks is filled from the other; a field it has is
 *    kept.** "Lacks" means absent OR empty, because a `company: ""` on a
 *    half-filled record is a gap and not a statement.
 *  - **The survivor's `url` stays canonical** and the other's becomes an
 *    `aliasUrls` entry, which is the whole point of the field: the record now
 *    answers to both ways the user reached the posting, and `id` — derived from
 *    `url` and only from `url` — does not move.
 *
 * The rule that is NOT symmetric is `status`: the survivor's wins, so merging
 * an `interviewing` record into an `interested` one loses the lifecycle
 * position. That is deliberate rather than overlooked. Picking the "further
 * along" status would need an ordering `JOB_STATUS_ORDER`'s own docblock
 * refuses to claim (`offer`, `rejected` and `archived` are terminal branches,
 * not later stages), and the affordance instead lets the user merge from
 * EITHER row — choosing the survivor is how they choose which status stays.
 *
 * `createdAt` is not decided here at all: `putRecord` takes the existing row's
 * value over anything a caller passes, so the survivor keeps the date it was
 * first saved no matter what this function returns.
 */

import { dedupeCanonicalUrls } from "./storage/index.ts";
import type { JobRecord } from "./storage/index.ts";

/**
 * Keys the field-by-field fill never touches.
 *
 * The three timestamps and `id` belong to the store. `notes` and `aliasUrls`
 * have their own rules below — a fill would overwrite one and truncate the
 * other. `__proto__` can only arrive on a record that predates the contract
 * check (`FORBIDDEN_KEY` in `storage/record-contract.ts` refuses it at every
 * boundary), and assigning it by computed key would reach the prototype setter
 * rather than write a property.
 *
 * `capture` and `origin` are excluded for a different reason, and it is the one
 * worth stating: the fill exists for facts about the POSTING — a salary range,
 * a JD, a work model — which are equally true of whichever record survives,
 * because both records describe the same job. These two are claims about how a
 * RECORD came to exist, which is true of one record and cannot be inherited by
 * another. A user's hand-typed row that absorbs an extension capture would
 * otherwise start carrying `capture: {producer: "offlinecv-extension", …}` — a
 * compatibility claim about a record that no longer exists, made on behalf of a
 * producer that never wrote this one (`JobRecord.capture` says "absent for
 * every record this app creates", and §7 of `docs/job-capture-contract.md`
 * exists so a future reader can decide whether to trust the fields) — and start
 * rendering "from a job alert" for a row the user typed themselves.
 */
const NOT_FILLED = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "notes",
  "aliasUrls",
  "capture",
  "origin",
  "__proto__",
]);

/** Absent, blank, or an empty list — the three shapes of "the user has not put
 *  anything here", which is what makes a field eligible to be filled from the
 *  record being absorbed. `null` is NOT missing: it is a value some producer
 *  chose, under a key this build may not even know. */
function isMissing(value: unknown): boolean {
  if (value === undefined || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

/**
 * The two records' notes, in survivor-then-absorbed order.
 *
 * Returns the survivor's own value — possibly `undefined` — when there is
 * nothing to add, so a merge cannot invent a `notes` key on a record that never
 * had one. Text is compared trimmed but written verbatim: whitespace is not
 * evidence of a difference, and it is also not ours to tidy.
 */
function joinNotes(survivor?: string, absorbed?: string): string | undefined {
  const kept = typeof survivor === "string" ? survivor : "";
  const added = typeof absorbed === "string" ? absorbed : "";
  if (added.trim() === "") return survivor;
  if (kept.trim() === "") return absorbed;
  if (kept.trim() === added.trim()) return survivor;
  return `${kept}\n\n${added}`;
}

/** A record's `aliasUrls` as strings, defensively: the store's write path is
 *  permissive and a restored backup may carry anything the validator has since
 *  learnt to drop. */
function aliasEntries(job: JobRecord): string[] {
  const entries = Array.isArray(job.aliasUrls) ? job.aliasUrls : [];
  return entries.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Every other URL the merged record is reachable at: the survivor's existing
 * aliases, then the absorbed record's `url`, then its aliases.
 *
 * Deduplicated by CANONICAL form while storing the spelling as it was first
 * seen — two aliases that differ only by `www.` or a `utm_` parameter are one
 * alias, and there is no reason to prefer a rewritten spelling of a URL the
 * user may recognise. The final `url` is excluded for the same reason: a record
 * listing its own address as an alias of itself says nothing.
 *
 * An entry that is not an absolute http(s) URL is dropped. It could never match
 * anything (`canonicalJobUrl` is what a comparison runs through), and §9 of the
 * capture contract would drop it on the next import anyway — writing one here
 * would mean this build storing a record its own validator refuses. The one
 * value that can cost: an absorbed record whose `url` the user typed by hand
 * (`acme.com/jobs/1`) is lost when the survivor already has a `url` of its own.
 */
function mergeAliasUrls(
  url: string | undefined,
  survivor: JobRecord,
  absorbed: JobRecord,
): string[] {
  return dedupeCanonicalUrls(
    [
      ...aliasEntries(survivor),
      ...(typeof absorbed.url === "string" ? [absorbed.url] : []),
      ...aliasEntries(absorbed),
    ],
    typeof url === "string" ? [url] : [],
  );
}

/**
 * `survivor` with `absorbed` folded into it. Neither argument is mutated.
 *
 * Unknown extra keys take part in the fill, deliberately: the capture contract
 * preserves a key this build has never heard of precisely so a newer producer's
 * field survives a round trip through an older build, and a merge that dropped
 * the absorbed record's copy of one would be the same silent loss one step
 * later.
 */
export function mergeJobRecords(survivor: JobRecord, absorbed: JobRecord): JobRecord {
  const merged: JobRecord = { ...survivor };
  const fillable = merged as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(absorbed)) {
    if (NOT_FILLED.has(key)) continue;
    if (!isMissing(fillable[key]) || isMissing(value)) continue;
    fillable[key] = value;
  }

  const notes = joinNotes(survivor.notes, absorbed.notes);
  if (notes !== undefined) merged.notes = notes;

  // Read `merged.url`, not `survivor.url`: the fill above may just have given
  // the survivor the absorbed record's URL, and that URL is now the canonical
  // one rather than an alias of itself.
  const aliasUrls = mergeAliasUrls(merged.url, survivor, absorbed);
  // Assigned in BOTH directions. The spread above copied the survivor's own
  // `aliasUrls`, so leaving an empty result alone would keep a stale list — the
  // reachable case being a survivor whose only alias is the URL it just adopted
  // from the absorbed record, which is no longer an alias of anything.
  if (aliasUrls.length > 0) merged.aliasUrls = aliasUrls;
  else delete merged.aliasUrls;

  return merged;
}

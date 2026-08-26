// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Local-first storage — record shapes for the IndexedDB foundation (#321).
 *
 * Infrastructure only: the resume-library and job-tracker UIs (follow-ups) build
 * on these. The module is deliberately decoupled from parser types — a cached
 * parse rides along as an opaque `parse` payload so `src/lib/storage/` never
 * imports the heuristics graph. Callers that want the cached parse to survive
 * export/import (which is JSON, see backup.ts) should store a JSON-safe value.
 */

/** Fields every stored record carries — the generic CRUD keys on these. */
export interface StoredRecord {
  /** Stable primary key (keyPath). Generated with `crypto.randomUUID()` when a
   *  caller doesn't supply one. */
  id: string;
  /** Epoch ms of first write. Set once, preserved across updates. */
  createdAt: number;
  /** Epoch ms of the most recent write. */
  updatedAt: number;
  /**
   * Epoch ms this record was deleted — a **tombstone** (#730). Absent on every
   * live record, and absent is the only reading of "not deleted": a `0` would
   * be a valid epoch-ms timestamp.
   *
   * A tombstone exists because a record that is simply *gone* replicates
   * nothing. Any second holder of this library — another device, a backup file
   * a user restores from, a producer that captured the same posting — cannot
   * distinguish "deleted here" from "never existed here", so it re-adds the
   * record and the deletion undoes itself. The row has to stay behind to say
   * what happened.
   *
   * **It is declared on every record but only WRITTEN for `jobs` and
   * `letters`.** Those two replicate; `resumes` and `boards` hard-delete
   * through {@link deleteRecord} — a résumé's bytes are the bulk of the
   * database and holding them after a delete is the opposite of what the user
   * asked for, and `boards` is a pure cache whose miss path is already correct.
   * Declaring it once anyway keeps the soft-delete machinery in `crud.ts`
   * store-agnostic, which is where the rest of that layer already sits.
   *
   * Readers must filter. `getAllRecords` does it by default (opt out with
   * `includeDeleted`) so a caller has to go out of its way to see one.
   */
  deletedAt?: number;
}

/**
 * The stores that replicate, and therefore the ones that carry an `updatedAt`
 * index and a sync cursor (#730).
 *
 * `boards` is excluded deliberately and is not an oversight: it is a cache of
 * what a company's ATS board returned, re-fetched cheaply on a miss. Syncing it
 * would replicate staleness between devices and resurrect boards the registry
 * has since dropped — the same reason it is absent from the backup document.
 */
export type SyncableStoreName = "resumes" | "jobs" | "letters";

/**
 * Replication bookmarks for one object store — the `sync` store's record
 * shape (#730), keyed on the store name it describes.
 *
 * Deliberately **not** a {@link StoredRecord}. It is a bookmark, not a record:
 * it has no creation time worth keeping, nothing sorts it, it never
 * replicates, and it must never be tombstoned. Giving it the record shape would
 * mean `putRecord` stamping `updatedAt` on a cursor, which is a timestamp about
 * the bookmark rather than about anything a user has.
 *
 * The two cursors read from **different clocks**, and conflating them is the
 * bug this docblock exists to prevent:
 *
 *  - {@link lastPulledAt} is the REMOTE clock, held verbatim as whatever opaque
 *    string the remote handed back. It is compared only against other values
 *    from that same source. Parsing it into epoch ms would lose sub-millisecond
 *    precision, and a cursor that rounds *up* silently skips every record
 *    written inside the truncated interval.
 *  - {@link lastPushedAt} is THIS device's `Date.now()`, compared against
 *    `StoredRecord.updatedAt`, which is stamped from the same clock.
 *
 * Nothing in this build writes either one. The store lands here because the
 * schema migration that creates it lands here (see `db.ts`) — the reader is the
 * browser extension, which builds these modules from a pinned commit of this
 * repo and cannot add an object store of its own.
 */
export interface SyncCursorRecord {
  /** The object store these bookmarks describe — the keyPath. */
  id: SyncableStoreName;
  /** Opaque remote-clock bookmark: everything changed remotely at or before
   *  this point has been written locally. Absent until the first pull. */
  lastPulledAt?: string;
  /** Local `Date.now()` bookmark: every local record with a strictly greater
   *  `updatedAt` still needs pushing. Absent until the first push. */
  lastPushedAt?: number;
}

/** A saved resume: raw PDF bytes as a `Blob` (no base64 inflation at rest) plus
 *  a cached parse so reloading it doesn't re-run the cascade. */
export interface ResumeRecord extends StoredRecord {
  filename: string;
  /** Raw source bytes. Stored via IndexedDB structured clone — no base64 until
   *  export. */
  blob: Blob;
  /** Cached parse result (e.g. a `CascadeResult`). Opaque here by design; see
   *  the module note. Absent until a parse is cached. */
  parse?: unknown;
}

/**
 * Application status of a tracked job. A simple linear lifecycle
 * (`interested → applied → interviewing → offer / rejected / archived`) — a
 * status picker, not a workflow engine (#323).
 */
export type JobStatus =
  | "interested"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "archived";

/**
 * Where a job RECORD says it arrived from — display only (#745). A closed
 * vocabulary, unlike `JobStatus`: nothing renders an out-of-vocabulary origin
 * (see `JobRecord`'s own `origin` field below), so there is no case for
 * preserving one the way an unrecognised status is preserved.
 */
export type JobOrigin = "capture" | "alert" | "shared" | "import" | "manual";

/**
 * Where a job record came from, when it came from outside this app (#693).
 *
 * Absent on every record this app writes itself — an absent value means
 * "offlinecv, contract version 1". Present on a captured record, and the reason
 * it exists at all is that a producer version cannot be retrofitted: once a
 * third-party extension is writing records, a record with no version is
 * indistinguishable from one written before the field existed.
 *
 * Deliberately NOT `StorageExport.version`: that numbers the backup DOCUMENT
 * format, and a record outlives the file it arrived in.
 */
/**
 * Contract version a producer targets, carried on
 * {@link JobCaptureProvenance.contract}. Independent of `StorageExport.version`
 * (the backup DOCUMENT format): a record can outlive the file it arrived in, and
 * the two evolve for different reasons. Absent provenance means "written by this
 * app against version 1".
 *
 * Exported as part of the contract SURFACE, not awaiting a caller: §7 of
 * `docs/job-capture-contract.md` is normative for reimplementers, and this is
 * the number it tells them to send. Nothing in this build reads it, by design —
 * the validator requires `capture.contract` to be a finite number and does not
 * compare it against this constant, because refusing a record from a future
 * version is exactly the forward-compatibility failure §7 exists to avoid.
 *
 * It lives here, beside the field it fills, rather than in
 * `job-record-contract.ts` (which re-exports it): a version number is vocabulary
 * rather than validation, and this module is the vocabulary — zero imports and
 * nothing but declarations, which is what lets a producer-side consumer take the
 * number without taking the validator.
 *
 * `2` since #719 added the six posting-fact fields. **No migration**, and none
 * could be needed: every added field is optional, so a version-1 record is a
 * valid version-2 record that happens to omit them. The bump tells producers
 * there is more they MAY send, not that they must resend anything — a version-1
 * producer keeps working untouched.
 */
export const JOB_CAPTURE_CONTRACT_VERSION = 2;

export interface JobCaptureProvenance {
  /** The capture-contract version this producer targeted
   *  ({@link JOB_CAPTURE_CONTRACT_VERSION}). */
  contract: number;
  /** Free-text producer id, e.g. `"offlinecv-extension"`. */
  producer?: string;
  /** The producer's own release version. */
  producerVersion?: string;
  /** Epoch ms the producer captured the posting, which is not necessarily when
   *  the record was written here. */
  capturedAt?: number;
}

/** A tracked job (#323). Field shape pinned here now that the tracker UI exists;
 *  the store has lived in the foundation (#321) so both stores version together
 *  under one migration path. Every field is JSON-safe so the whole record
 *  survives the export/import round-trip (see backup.ts).
 *
 *  Since #693 this is a PUBLIC capture contract, not just an internal type:
 *  records arrive from a picked backup file and from producers outside this
 *  build. Adding a field here obliges you to add a rule for it in
 *  `job-record-contract.ts` (the mapped type there will not compile otherwise)
 *  and to describe it in `docs/job-capture-contract.md`. */
export interface JobRecord extends StoredRecord {
  /** Posting title, e.g. "Senior Frontend Engineer". */
  title: string;
  /** Hiring company. May be empty when the user hasn't filled it in yet. */
  company: string;
  /** Posting URL. Optional — the user pastes/types details, the record arrives
   *  via a restored backup import (see backup.ts), or a producer captured the
   *  posting it was viewing (see capture.ts); we never scrape. Must be an
   *  absolute `http`/`https` URL when it comes from outside this build: the
   *  tracker renders it straight into an anchor's `href`. It is also the input
   *  to id derivation, so two captures of one posting converge — see
   *  `job-url.ts`. */
  url?: string;
  /**
   * Other URLs the same posting is reachable at (#746) — an employer ATS link
   * found on an aggregator page, or the `url` of a record the user merged into
   * this one.
   *
   * **Additive, and display/dedupe-only.** `url` stays the canonical one and
   * `id` is derived from `url` and ONLY from `url`: no value here may change a
   * record's identity, because that would fork the id space, which is the exact
   * failure `job-url.ts` exists to prevent. Nothing in `deriveJobId` or
   * `canonicalJobUrl` reads this field, and nothing may start.
   *
   * An alias is a link between two URLs discovered by something with more
   * context than a URL parser — a user clicking Merge, a producer that followed
   * an "Apply" link. It is never inferred from the URLs themselves: an
   * aggregator URL and an employer ATS URL share no host, path or parameter, so
   * no canonicalisation rule can ever relate them, and none should try.
   *
   * Every entry is an absolute http(s) URL, the same bar `url` clears for an
   * `href` — but unlike `url`, a non-absolute entry is DROPPED rather than kept
   * (see §9 of `docs/job-capture-contract.md`).
   */
  aliasUrls?: string[];
  /** Free-text notes. */
  notes?: string;
  /** Where this job sits in the application lifecycle. */
  status: JobStatus;
  /** Optional link to a saved resume (`ResumeRecord.id`) — the version used for
   *  this job. Cleared (not orphaned) if that resume is later deleted. */
  resumeId?: string;
  /** Optional pasted job description, when the job came from / ran a JD match. */
  jdText?: string;

  // ─── Posting facts, as the posting states them (#719) ─────────────────────
  //
  // All optional, all `string`, so the whole group stays JSON-safe for the
  // export/import round trip and needs no migration — an existing record simply
  // lacks them. Values are passed through VERBATIM: nothing here is parsed into
  // numbers, normalised to an enum, or reconciled against `jdText`. A lossy
  // parse at the boundary is unrecoverable downstream, and interpreting these is
  // a consumer's job.
  //
  // These are display-only record-keeping and are **not** ranking inputs.
  // `src/lib/job-search/rate-saved-jobs.ts` rates the saved library on fitness
  // alone because there is no query behind it — no location preference, no comp
  // floor. The missing input is the *query's*, not the posting's, so carrying
  // the posting's own values here does not give that module anything to rank on.

  /** Where the posting says the job is, free text: `"Austin, TX"`, `"Remote
   *  (US)"`. Not geocoded and not split into city/region. */
  location?: string;
  /** Compensation as the posting states it: `"$180k – $220k"`. Free text, never
   *  parsed into numbers — currency, period and range syntax vary per posting,
   *  and a wrong parse is worse than an unparsed string. */
  salaryRange?: string;
  /** ISO date the posting was published. A snapshot of the posting's age **at
   *  capture**, which only decays — so a renderer must show it absolute
   *  (`2026-07-28`), never as "3 days ago" against today's clock. */
  datePosted?: string;
  /** The posting's own declared arrangement (`"remote"`, `"hybrid"`), taken from
   *  structured data — never inferred by a regex over `jdText`. */
  workModel?: string;
  /** schema.org `employmentType` (`"FULL_TIME"`, `"CONTRACTOR"`), passed through
   *  unvalidated: the vocabulary is the publisher's, not ours. */
  employmentType?: string;
  /** ISO date the posting declares it expires, where it declares one. */
  validThrough?: string;

  /** Optional JD-match result carried over from the JD-fit flow. Opaque +
   *  JSON-safe by contract so it survives export/import — enforced at the
   *  external boundary by `findJsonSafetyProblem` (#693). */
  matchResult?: unknown;
  /** Provenance for a record written by a producer outside this build (#693).
   *  Absent for every record this app creates. */
  capture?: JobCaptureProvenance;

  /** Where this record says it came from, for DISPLAY ONLY (#745) — the
   *  tracker row renders a short phrase for it and nothing else may read it
   *  (see `job-origin-reach.test.ts`'s structural guard and
   *  `docs/job-capture-contract.md` §8). Never an input to merge, dedupe, or
   *  sync ordering.
   *
   *  Absent on any record with no better answer than "the user made it
   *  here" — every record this build's own UI writes, and a producer that
   *  simply has no opinion. An out-of-vocabulary value is dropped rather
   *  than kept, unlike `status`: there is no row that renders it, so keeping
   *  it would carry a value nothing ever surfaces. */
  origin?: JobOrigin;
}

/** The lifecycle order for display grouping and the "advance status" affordance
 *  (#323). Terminal branches (`offer` / `rejected` / `archived`) all sit at the
 *  end; there is no forced single path between them. */
export const JOB_STATUS_ORDER: readonly JobStatus[] = [
  "interested",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "archived",
];

/** The closed vocabulary {@link JobOrigin} draws from — exported so
 *  `job-record-contract.ts`'s `isKnownOrigin` and this module share exactly
 *  one definition, the same reason {@link JOB_STATUS_ORDER} exists. No
 *  "order" to it; `origin` has no lifecycle. */
export const JOB_ORIGINS: readonly JobOrigin[] = [
  "capture",
  "alert",
  "shared",
  "import",
  "manual",
];

/** A company on the user's persisted job-search shortlist (#864) — a
 *  statement of user intent, unlike `BoardCacheRecord`'s re-fetchable cache.
 *  `ats` is kept as a bare string rather than importing job-search's `Ats`
 *  union, for the same reason `BoardCacheRecord.postings` stays `unknown[]`:
 *  this module doesn't import the job-search graph. Not in
 *  `SyncableStoreName` and absent from the backup document — local-first,
 *  per-browser, no account, no export (see the issue's out-of-scope list). */
export interface WatchedCompanyRecord extends StoredRecord {
  /** ATS vendor — `"greenhouse"` | `"lever"` | `"ashby"`, mirrored from
   *  job-search's `Ats` union. */
  ats: string;
  /** The ATS board slug, e.g. "stripe". */
  slug: string;
  /** Display name, e.g. "Stripe". */
  displayName: string;
}

/** A cached company ATS board: the light-index postings one board returned,
 *  keyed `${ats}:${slug}` (#533). A pure CACHE — deliberately absent from the
 *  backup document, because re-fetching a board is cheap and a stale export
 *  would resurrect boards the registry has since dropped. `postings` is opaque
 *  here for the same reason `ResumeRecord.parse` is: this module never imports
 *  the job-search graph. */
export interface BoardCacheRecord extends StoredRecord {
  postings: unknown[];
}

/**
 * Where a letter came from, when it came from outside this build (#711).
 *
 * The same shape as {@link JobCaptureProvenance} and there for the same
 * reason — a producer version cannot be retrofitted — but it is a SEPARATE
 * type because the two number different contracts (`LETTER_CONTRACT_VERSION`
 * vs `JOB_CAPTURE_CONTRACT_VERSION`) and carry different timestamps: a job is
 * *captured* from a page that already existed, a letter is *generated*.
 *
 * Absent on everything this build writes. That absence is the whole point:
 * #711 stores letters without generating them, so the first real writers are
 * outside producers — a Claude Code skill driving the page, the browser
 * extension — and a letter with no provenance must be readable as "offlinecv
 * itself wrote this", not as "some producer that predates the field".
 */
export interface LetterProvenance {
  /** The letter-contract version this producer targeted
   *  (`LETTER_CONTRACT_VERSION`). */
  contract: number;
  /** Free-text producer id, e.g. `"claude-code-letter-skill"`. */
  producer?: string;
  /** The producer's own release version. */
  producerVersion?: string;
  /** Epoch ms the producer generated the draft, which is not necessarily when
   *  the record was written here. */
  generatedAt?: number;
}

/**
 * A cover letter, scoped to one job, to one company, or to nothing at all
 * (#711, #766). The three-case lattice is on {@link LetterRecord.jobId}.
 *
 * A separate store rather than a field on {@link JobRecord} because letters are
 * ITERATED — several drafts per scope, and versions of one draft, are the
 * normal case, and a field gives you exactly one forever. That a letter is no
 * longer necessarily a job's at all (#766) is the second, independent reason
 * the same decision was right.
 *
 * Every field is JSON-safe (no `Blob`, unlike `ResumeRecord`), so the whole
 * record rides through the export document as-is with no base64 step.
 *
 * Like `JobRecord`, this is a PUBLIC contract, not an internal type: #711
 * stores letters without generating them, so every writer that matters is
 * outside this build. Adding a field here obliges you to add a rule for it in
 * `letter-contract.ts` (the mapped type there will not compile otherwise) and
 * to describe it in `docs/cover-letter-contract.md`.
 */
export interface LetterRecord extends StoredRecord {
  /**
   * The job this letter is for (`JobRecord.id`). Optional since contract v2
   * (#766), and it is one of two keys that together give a letter its SCOPE.
   *
   * Exactly one reading applies to any record:
   *
   * | `jobId` | `companyKey` | Reading |
   * |---|---|---|
   * | set | — | Letter for one job (every letter written before v2) |
   * | — | set | Letter for one company |
   * | — | — | Standard letter |
   *
   * **A record carrying BOTH is refused** (`validateLetterRecord`). It has no
   * single reading, and accepting one would mean picking a precedence rule no
   * producer could guess. Each key is a non-empty string *when present*, so
   * `""` stays a refusal rather than becoming a silent fourth state.
   *
   * Deleting a job still CASCADES to that job's letters, and cannot reach a
   * jobless one — `lettersForJob` matches `letter.jobId === jobId` and
   * `undefined` never equals a real id, so the scoping is what makes the
   * cascade safe rather than a guard bolted on beside it. See
   * `deleteLettersForJob` and §5 of the contract doc.
   *
   * What v1 said here — that a letter with no job is unreachable from every
   * surface, so `jobId` had to be required — was true when written and is
   * exactly what #765 invalidates: once a standard/company letter surface
   * exists, a jobless letter is reachable.
   */
  jobId?: string;
  /**
   * The company this letter is for, as a derived key (`deriveCompanyKey` in
   * `company-key.ts`), for a letter that belongs to an employer rather than to
   * one posting. See `jobId` above for the lattice the two keys form.
   *
   * There is no company entity — {@link JobRecord.company} is free text and may
   * be empty — so this is a NORMALISED string, not a foreign key, and it is
   * **advisory**: per #765 it only ever drives a suggestion the user confirms.
   * Nothing auto-attaches a letter to a job by company match, for the reason
   * `aliasUrls` gives about links never being inferred: a normaliser collides,
   * and a false merge must cost a declined suggestion rather than a letter
   * silently attached to the wrong employer.
   */
  companyKey?: string;
  /** Optional link to the saved resume this letter was written from
   *  (`ResumeRecord.id`). Cleared (not orphaned) if that resume is later
   *  deleted — the same rule `JobRecord.resumeId` follows. */
  resumeId?: string;
  /** The letter itself, markdown. */
  body: string;
  /** User-facing name, so two drafts for one job are tellable apart. */
  label?: string;
  /** Provenance for a record written by a producer outside this build. Absent
   *  for every record this app creates. */
  producer?: LetterProvenance;
}

/**
 * Object-store names the generic CRUD in `crud.ts` operates over. Adding a
 * store is a schema-version bump (see db.ts).
 *
 * `sync` is absent on purpose. Every name here holds a {@link StoredRecord} and
 * `putRecord` stamps timestamps on the way in; {@link SyncCursorRecord} is
 * neither, so it gets its own two-function accessor (`sync-cursor.ts`) rather
 * than a cast that would let `putRecord` write a `createdAt` onto a bookmark.
 */
export type StoreName = "resumes" | "jobs" | "boards" | "letters" | "watched";

/** A resume as it appears in an export file: blob replaced by base64 + MIME so
 *  the whole backup is a single JSON document. */
export interface ExportedResume extends Omit<ResumeRecord, "blob"> {
  blobBase64: string;
  blobType: string;
}

/**
 * The export document as version 1 shipped it (see backup.ts). Kept as a named
 * type, not folded into an optional `letters?` key, because the distinction is
 * load-bearing: a v1 file has no `letters` key AT ALL, and saying so in the
 * type is what stops a reader treating "no letters" and "an empty letters
 * array" as the same evidence. Nothing writes one any more; import still reads
 * one, forever.
 */
export interface StorageExportV1 {
  version: 1;
  exportedAt: number;
  resumes: ExportedResume[];
  jobs: JobRecord[];
}

/** The current export document — v1 plus the letters store (#711). */
export interface StorageExportV2 extends Omit<StorageExportV1, "version"> {
  version: 2;
  letters: LetterRecord[];
}

/**
 * The full export document. `version` tracks the export FORMAT, independent of
 * the IndexedDB schema version (`DB_VERSION` in db.ts) and of the per-record
 * contract versions — the three number different things and move for different
 * reasons.
 *
 * A union rather than a single widening interface: `exportAll` only ever writes
 * {@link StorageExportV2}, and `importAll` accepts BOTH, which is the whole
 * back-compat requirement stated as a type.
 */
export type StorageExport = StorageExportV1 | StorageExportV2;

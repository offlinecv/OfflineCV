// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The runtime half of the job capture contract (#693) — the only gate an
 * externally-authored {@link JobRecord} passes through on its way into
 * IndexedDB, whether it came from a backup file the user picked (`backup.ts`)
 * or a producer that ships on its own release cadence (`capture.ts`, and the
 * browser extension behind it).
 *
 * `JobRecord` used to be an internal type: everything that wrote one was
 * typechecked against it in the same build, so the type WAS the validation.
 * Import and capture ended that. TypeScript guarantees nothing about a JSON
 * file or a `chrome.runtime` message, and the failure mode of getting this
 * wrong is not a crash — it is a record that renders as a blank row, or an
 * anchor whose `href` executes.
 *
 * The prose half is `docs/job-capture-contract.md`. It is normative for
 * producers; this module must never disagree with it.
 *
 * The generic machinery — the rule shape, the JSON-safety walk, the
 * preserve-unknown-keys pass — lives in `record-contract.ts` and is shared with
 * the cover-letter contract (#711). What stays here is everything a JOB record
 * specifically means.
 *
 * ## The drift guard
 *
 * The danger the issue names is this file becoming a SECOND definition of
 * `JobRecord` that quietly stops covering a field — a validator that reports
 * success on a record it no longer checks is worse than no validator. So the
 * rules are not a hand-written list: {@link JOB_RECORD_RULES} is typed
 * `{ [K in keyof Required<JobRecord>]: FieldRule<Required<JobRecord>[K]> }`,
 * which means
 *
 *   - adding a field to `JobRecord` and not to this map is a **compile error**
 *     (the mapped type demands every key), and
 *   - giving a field a guard that narrows to the wrong type is a **compile
 *     error** too (a `value is string` predicate is not assignable where
 *     `value is number` is required).
 *
 * `job-record-contract.test.ts` then loops over the map, so a newly-added field
 * is exercised without anyone remembering to write a case for it. The one field
 * the type system cannot help with is `matchResult`, whose declared type is
 * `unknown`; its real check is `findJsonSafetyProblem`, wired explicitly.
 */

import type { JobRecord, JobStatus, JobOrigin, JobCaptureProvenance } from "./types.ts";
import { JOB_STATUS_ORDER, JOB_ORIGINS } from "./types.ts";
import { isAbsoluteUrl, isCapturableJobUrl, dedupeCanonicalUrls } from "./job-url.ts";
import {
  checkDeclaredFields,
  collectJsonSafeExtras,
  explainJsonSafety,
  findJsonSafetyProblem,
  hasOwn,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  isProvenanceLike,
  isString,
  FORBIDDEN_KEY,
  type FieldRule,
} from "./record-contract.ts";

/**
 * Re-exported so this module — the one `docs/job-capture-contract.md` names as
 * the contract's runtime half — still presents the whole surface in one place.
 * It LIVES in `types.ts` because the version number is vocabulary, not
 * validation: it is the value of a field declared there, and the validator
 * deliberately never reads it.
 *
 * The split is also load-bearing. `src/lib/jd-extract/to-job-record.ts` imports
 * this constant into a bundle injected into a live page, and importing it from
 * here would drag the rules map, `KNOWN_FIELDS`'s `new Set` (a top-level side
 * effect no bundler may assume away) and all of `record-contract.ts` along with
 * it — 2.9 KB of validator, measured, against a 25 KB budget, to carry one
 * integer.
 */
export { JOB_CAPTURE_CONTRACT_VERSION } from "./types.ts";

/** A reason a record was refused, or a repair that was applied. One sentence,
 *  addressed to whoever has to fix the producer or the file. */
export type JobRecordIssue = string;

/**
 * Outcome of validating one candidate record.
 *
 * `warnings` on the success branch is not decoration: it is how a record that
 * was ACCEPTED but not pristine — an out-of-union status, a `url` that is not
 * absolute — reaches a caller that can tell the user. Callers must surface it
 * or deliberately drop it; see `backup.ts` for the import path's choice.
 */
export type JobRecordValidation =
  | { ok: true; record: JobRecord; warnings: JobRecordIssue[] }
  | { ok: false; reasons: JobRecordIssue[] };

/**
 * `status` accepts ANY string, including one outside {@link JOB_STATUS_ORDER},
 * and the predicate widens it to `JobStatus`. That is a deliberate lie in the
 * same family as `jobs.ts`'s permissive-write cast, and it is the decision the
 * issue asks to be written down:
 *
 * An out-of-union status is **preserved verbatim**, with a warning — not
 * dropped, and not coerced to `"interested"`.
 *
 *   - Coercing is exactly the "swallow" that `JobStatusPicker.jobStatusLabel`
 *     and `JobTracker`'s bucketing both exist to prevent; both docblocks state
 *     they surface a "corrupt or future-version imported record" rather than
 *     hide it, and both would become dead code if this coerced.
 *   - Dropping the record removes the only surface on which the user could see
 *     and repair the bad value — one click in `JobStatusPicker` fixes it.
 *   - Coercing loses information irrecoverably; preserving costs one warning
 *     and keeps a future offlinecv's seventh status importable into today's
 *     build, which is the same forward-compatibility rule unknown extra keys
 *     get.
 *
 * A status that is present but not a string IS refused: `JobTracker` buckets on
 * the raw value, and a non-string key produces a bucket per object identity.
 */
const isStatusLike = (value: unknown): value is JobStatus => typeof value === "string";

/**
 * Widens like `isStatusLike` above, for the same reason: a malformed `origin`
 * must never refuse the whole record. It diverges from `isStatusLike` after
 * that — `collectAcceptedWarnings` and `validateJobRecord` below strip an
 * out-of-vocabulary value rather than keeping it, because `origin` is
 * display-only glossary text and a value this build doesn't recognise cannot
 * be phrased. See §8 of `docs/job-capture-contract.md`.
 */
const isOriginLike = (value: unknown): value is JobOrigin => typeof value === "string";

/**
 * Widens to `string[]` from nothing more than "it is an array" (#746), so the
 * per-ENTRY verdict can be a drop rather than a refusal: `collectAcceptedWarnings`
 * warns about each entry that is not an absolute http(s) URL and
 * `validateJobRecord` filters them out before the record is stored. See §9 of
 * `docs/job-capture-contract.md`.
 *
 * The array-ness itself IS a refusal, and that is not a contradiction of the
 * "never refuses" rule the issue states: that rule is about entries. A field
 * whose declared type is wrong end-to-end — `aliasUrls: "https://…"`, a single
 * string where a list belongs — is a broken producer, and every other field
 * here refuses one (`status: 3`, `origin: 3`). Telling them beats storing a
 * value no reader can iterate.
 */
const isAliasUrlsLike = (value: unknown): value is string[] => Array.isArray(value);

/** One rejected `aliasUrls` entry, phrased for a warning without ever
 *  stringifying an untrusted value: a non-string entry is described by its
 *  type, so a function or a 10 MB object cannot become the warning text. */
function describeAliasEntry(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : `a value of type ${typeof value}`;
}

/** The entries of an already-guarded `aliasUrls` that clear the `href` bar —
 *  the value actually stored. Absolute http(s) only: unlike `url`, there is no
 *  legacy corpus of half-typed values to protect here and nothing renders an
 *  alias as the row's link, so an entry that cannot be canonicalised is an
 *  entry that can never match anything. */
function keptAliasUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => isString(entry) && isCapturableJobUrl(entry));
}

/** `url` refuses only what an `href` must never receive. An absolute URL whose
 *  scheme is not http(s) — `javascript:`, `data:`, `file:` — is refused;
 *  a string that is not absolute at all (`acme.com`) is accepted and warned,
 *  because it is inert in an `href` and is the user's own typed text. */
const isUrlLike = (value: unknown): value is string =>
  typeof value === "string" && (!isAbsoluteUrl(value) || isCapturableJobUrl(value));

const isJsonSafe = (value: unknown): value is unknown =>
  findJsonSafetyProblem(value, "value") === null;

/**
 * A leading `YYYY-MM-DD`. Deliberately a prefix match, not a full-date parse: a
 * publisher that sends `2026-07-28T00:00:00Z` has stated an absolute date and is
 * doing nothing wrong, and this is a warning's threshold rather than a
 * refusal's.
 */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

const isCaptureProvenance = (value: unknown): value is JobCaptureProvenance =>
  isProvenanceLike(value, "capturedAt", "capture");

/**
 * One rule per `JobRecord` field. See the drift-guard note in the module
 * docblock — the mapped type, not this list, is what keeps it complete.
 *
 * `createdAt` / `updatedAt` are optional because `putRecord` owns them: a
 * backup carries them (so `createdAt` survives a restore) and a capture omits
 * them (so the store stamps a fresh one). Present-but-not-a-number is still a
 * refusal — the tracker sorts on `updatedAt` and formats it as a date.
 */
export const JOB_RECORD_RULES: {
  [K in keyof Required<JobRecord>]: FieldRule<Required<JobRecord>[K]>;
} = {
  id: { required: true, check: isNonEmptyString, expected: "a non-empty string" },
  createdAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  updatedAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  // A tombstone (#730). Accepted from a FILE, because the export document
  // carries deletions and a restore that dropped them would resurrect every
  // job the user had deleted. Not accepted from a CAPTURE: `captureJob` strips
  // it, since a producer telling us a posting exists is not in a position to
  // tell us the user deleted it. See §5 of the contract doc.
  deletedAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  title: { required: true, check: isString, expected: "a string" },
  company: { required: false, check: isString, expected: "a string" },
  url: {
    required: false,
    check: isUrlLike,
    expected: "an http or https URL (an absolute URL with any other scheme is refused)",
  },
  aliasUrls: {
    required: false,
    check: isAliasUrlsLike,
    expected: "an array of absolute http or https URLs",
  },
  notes: { required: false, check: isString, expected: "a string" },
  status: { required: false, check: isStatusLike, expected: "a string" },
  resumeId: { required: false, check: isNonEmptyString, expected: "a non-empty string" },
  jdText: { required: false, check: isString, expected: "a string" },

  // The six posting facts (#719). Every one is `isString` on purpose. They are
  // passed through verbatim — a validator that parsed `salaryRange` into numbers
  // or coerced `employmentType` onto a closed enum would be the "repair" this
  // contract refuses to do, and the vocabularies belong to the publisher. The
  // two date fields are warned about rather than refused; see
  // `collectAcceptedWarnings`.
  location: { required: false, check: isString, expected: "a string" },
  salaryRange: { required: false, check: isString, expected: "a string" },
  datePosted: { required: false, check: isString, expected: "a string, ideally an ISO date" },
  workModel: { required: false, check: isString, expected: "a string" },
  employmentType: { required: false, check: isString, expected: "a string" },
  validThrough: { required: false, check: isString, expected: "a string, ideally an ISO date" },

  matchResult: {
    required: false,
    check: isJsonSafe,
    expected: "a JSON-safe value (see findJsonSafetyProblem)",
    explain: (value) => explainJsonSafety(value, "matchResult"),
  },
  capture: {
    required: false,
    check: isCaptureProvenance,
    expected: "an object with a finite `contract` number",
    explain: (value) => explainJsonSafety(value, "capture"),
  },
  origin: { required: false, check: isOriginLike, expected: "a string" },
};

/** Field names the rules cover — everything else on an incoming record is an
 *  unknown extra key. */
const KNOWN_FIELDS = new Set(Object.keys(JOB_RECORD_RULES));

/**
 * Warnings, not refusals: these run only on values that already passed their
 * guard, so each names a record we ACCEPTED with something a caller should say
 * out loud. See the decision notes on `isStatusLike` and `isUrlLike`.
 *
 * `datePosted` and `validThrough` warn on anything not starting `YYYY-MM-DD`.
 * The reason is the whole reason those fields exist: a posting's age is a fact
 * about the moment it was captured, so `"3 days ago"` is not merely a
 * lower-quality value — it silently becomes wrong the day after it is stored,
 * and no reader can tell. Warned rather than refused because the string is still
 * more than nothing, and the same asymmetry applies as everywhere else here:
 * refusing costs the user the record, warning costs them one sentence.
 */
function collectAcceptedWarnings(checked: Record<string, unknown>): JobRecordIssue[] {
  const warnings: JobRecordIssue[] = [];
  if (typeof checked.status === "string" && !isKnownStatus(checked.status)) {
    warnings.push(
      `Status "${checked.status}" is outside this build's lifecycle; it was kept as-is.`,
    );
  }
  if (typeof checked.url === "string" && !isAbsoluteUrl(checked.url)) {
    warnings.push(`URL "${checked.url}" is not an absolute URL; it was kept as-is.`);
  }
  for (const field of ["datePosted", "validThrough"] as const) {
    const value = checked[field];
    if (typeof value === "string" && value !== "" && !ISO_DATE_PREFIX.test(value)) {
      warnings.push(
        `\`${field}\` "${value}" is not an ISO date; it was kept as-is, but a relative date decays and cannot be rendered absolutely.`,
      );
    }
  }
  // Unlike `status`, an out-of-vocabulary `origin` is DROPPED — see
  // `isOriginLike`'s docblock — so this warns about a removal, not a keep.
  if (typeof checked.origin === "string" && !isKnownOrigin(checked.origin)) {
    warnings.push(`Origin "${checked.origin}" is not one this build recognises; it was dropped.`);
  }
  warnings.push(...collectAliasUrlWarnings(checked.aliasUrls));
  return warnings;
}

/**
 * One warning per dropped `aliasUrls` entry (#746) — per ENTRY, never a
 * refusal, because an alias is an extra way to reach a posting and losing one
 * costs the user a duplicate they can still merge by hand. Losing the whole
 * record over it would cost them the application.
 */
function collectAliasUrlWarnings(value: unknown): JobRecordIssue[] {
  if (!Array.isArray(value)) return [];
  const kept = new Set(keptAliasUrls(value));
  return value
    .filter((entry) => !(isString(entry) && kept.has(entry)))
    .map(
      (entry) =>
        `\`aliasUrls\` entry ${describeAliasEntry(entry)} is not an absolute http or https URL; it was dropped.`,
    );
}

/**
 * Validate one candidate record and return it in the shape the store accepts.
 *
 * ## Unknown extra keys are PRESERVED
 *
 * A key this build has never heard of rides through onto the stored record
 * rather than being stripped. The issue requires the choice to be explicit, and
 * this is the reasoning: dropping unknown keys makes an export→import→export
 * cycle lossy in a way nothing reports. A user who exports from a newer
 * offlinecv, restores on an older one, and exports again would find the newer
 * build's fields gone — silent data loss caused by the very layer added to
 * prevent it. IndexedDB stores them for free, and the tracker ignores what it
 * does not render.
 *
 * The bounded exception is an own `__proto__` key, which is refused outright
 * (see `FORBIDDEN_KEY`) — it is never a forward-compatible field.
 *
 * ## What is repaired rather than refused
 *
 * An absent `status` becomes `"interested"`, matching `createJob`'s documented
 * default, so a producer that omits a lifecycle it has no opinion about is not
 * punished for it. An out-of-vocabulary `origin` is dropped — see
 * `isOriginLike`'s docblock. An `aliasUrls` entry that is not an absolute
 * http(s) URL is dropped one entry at a time, and an `aliasUrls` left empty by
 * that is removed entirely. Nothing else is rewritten.
 */
export function validateJobRecord(value: unknown): JobRecordValidation {
  if (!isPlainObject(value)) {
    return { ok: false, reasons: ["A job record must be a plain JSON object."] };
  }
  if (hasOwn(value, FORBIDDEN_KEY)) {
    return { ok: false, reasons: ["A job record must not carry a `__proto__` key."] };
  }

  const { reasons, checked } = checkDeclaredFields(value, JOB_RECORD_RULES);
  const warnings = collectAcceptedWarnings(checked);

  if (reasons.length > 0) return { ok: false, reasons };

  // Strip a dropped origin AFTER warning about it above, and before the
  // `...checked` spread below — otherwise the unrecognised value would ride
  // straight through onto the stored record.
  if (typeof checked.origin === "string" && !isKnownOrigin(checked.origin)) {
    delete checked.origin;
  }

  // Same shape, per entry (#746): warned about above, removed here. An
  // `aliasUrls` left with nothing in it is deleted rather than stored as `[]` —
  // "no aliases" has one representation, and an empty array on the record would
  // say nothing a missing key does not.
  if (checked.aliasUrls !== undefined) {
    const aliases = keptAliasUrls(checked.aliasUrls);
    const deduped = dedupeCanonicalUrls(aliases, typeof checked.url === "string" ? [checked.url] : []);
    if (deduped.length > 0) checked.aliasUrls = deduped;
    else delete checked.aliasUrls;
  }

  // Extras are gathered only after the record is otherwise accepted — a refused
  // record has nothing to preserve. They are held to the same JSON-safety bar
  // as `matchResult`: a preserved key that can't survive the next export would
  // be preservation in name only.
  const { extras, problem } = collectJsonSafeExtras(value, KNOWN_FIELDS);
  if (problem) {
    return { ok: false, reasons: [`\`${problem.path}\`: ${problem.reason}.`] };
  }

  return {
    ok: true,
    record: {
      ...extras,
      ...checked,
      status: (checked.status as JobStatus | undefined) ?? "interested",
    } as JobRecord,
    warnings,
  };
}

/** True when `status` is one this build's lifecycle knows. Reads
 *  `JOB_STATUS_ORDER` so the vocabulary has exactly one definition. */
export function isKnownStatus(status: string): status is JobStatus {
  return (JOB_STATUS_ORDER as readonly string[]).includes(status);
}

/** True when `origin` is one of {@link JOB_ORIGINS}. Reads that constant so
 *  the vocabulary has exactly one definition, the same reason
 *  {@link isKnownStatus} reads `JOB_STATUS_ORDER`. Module-private: nothing
 *  outside this file needs to ask, since an unrecognised value never survives
 *  {@link validateJobRecord}. */
function isKnownOrigin(origin: string): origin is JobOrigin {
  return (JOB_ORIGINS as readonly string[]).includes(origin);
}

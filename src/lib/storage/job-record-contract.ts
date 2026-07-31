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
 * `unknown`; its real check is {@link findJsonSafetyProblem}, wired explicitly.
 */

import type { JobRecord, JobStatus, JobCaptureProvenance } from "./types.ts";
import { JOB_STATUS_ORDER } from "./types.ts";
import { isAbsoluteUrl, isCapturableJobUrl } from "./job-url.ts";

/**
 * Contract version a producer targets, carried on `JobRecord.capture.contract`.
 * Independent of `StorageExport.version` (the backup DOCUMENT format, still 1):
 * a record can outlive the file it arrived in, and the two evolve for different
 * reasons. Absent provenance means "written by this app against version 1".
 *
 * Exported as part of the contract SURFACE, not awaiting a caller: §7 of
 * `docs/job-capture-contract.md` is normative for reimplementers, and this is
 * the number it tells them to send. Nothing in this build reads it, by design —
 * the validator requires `capture.contract` to be a finite number and does not
 * compare it against this constant, because refusing a record from a future
 * version is exactly the forward-compatibility failure §7 exists to avoid.
 */
export const JOB_CAPTURE_CONTRACT_VERSION = 1;

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

/** A type predicate over `unknown`, narrowing to one field's declared type. */
type Guard<T> = (value: unknown) => value is T;

interface FieldRule<T> {
  /** False ⇒ the key may be absent. Absent is never the same as present-and-
   *  wrong: an absent optional field is silent, a wrong one is a reason. */
  required: boolean;
  check: Guard<T>;
  /** Phrased as the producer's obligation, because that is who reads it. */
  expected: string;
  /** A sharper reason for a value that failed `check`, when the rule can point
   *  at WHERE inside a nested value it went wrong. `expected` alone is useless
   *  for a 200-key `matchResult` — "not JSON-safe" doesn't tell a producer
   *  which key to fix. Returns undefined to fall back to `expected`. */
  explain?: (value: unknown) => string | undefined;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

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

/** `url` refuses only what an `href` must never receive. An absolute URL whose
 *  scheme is not http(s) — `javascript:`, `data:`, `file:` — is refused;
 *  a string that is not absolute at all (`acme.com`) is accepted and warned,
 *  because it is inert in an `href` and is the user's own typed text. */
const isUrlLike = (value: unknown): value is string =>
  typeof value === "string" && (!isAbsoluteUrl(value) || isCapturableJobUrl(value));

const isJsonSafe = (value: unknown): value is unknown =>
  findJsonSafetyProblem(value, "value") === null;

const isCaptureProvenance = (value: unknown): value is JobCaptureProvenance => {
  if (!isPlainObject(value)) return false;
  if (!isFiniteNumber(value.contract)) return false;
  for (const key of ["producer", "producerVersion"] as const) {
    if (value[key] !== undefined && !isString(value[key])) return false;
  }
  if (value.capturedAt !== undefined && !isFiniteNumber(value.capturedAt)) return false;
  return findJsonSafetyProblem(value, "capture") === null;
};

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
  title: { required: true, check: isString, expected: "a string" },
  company: { required: false, check: isString, expected: "a string" },
  url: {
    required: false,
    check: isUrlLike,
    expected: "an http or https URL (an absolute URL with any other scheme is refused)",
  },
  notes: { required: false, check: isString, expected: "a string" },
  status: { required: false, check: isStatusLike, expected: "a string" },
  resumeId: { required: false, check: isNonEmptyString, expected: "a non-empty string" },
  jdText: { required: false, check: isString, expected: "a string" },
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
};

function explainJsonSafety(value: unknown, path: string): string | undefined {
  const problem = findJsonSafetyProblem(value, path);
  return problem ? `\`${problem.path}\`: ${problem.reason}.` : undefined;
}

/** Field names the rules cover — everything else on an incoming record is an
 *  unknown extra key. */
const KNOWN_FIELDS = new Set(Object.keys(JOB_RECORD_RULES));

/** Own-key name refused wherever it appears. `JSON.parse` turns `"__proto__"`
 *  into a real own property, and a later `Object.assign`-style merge would then
 *  reach the prototype setter. No legitimate producer emits it. `constructor`
 *  is deliberately allowed: shadowing it on a plain data object is inert here
 *  (nothing reads `record.constructor`), and refusing a plausible field name
 *  costs a producer more than it buys. */
const FORBIDDEN_KEY = "__proto__";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Where a value stopped being JSON-safe, and why. */
export interface JsonSafetyProblem {
  /** Dotted/bracketed path from the value's root, e.g. `matchResult.rows[2].score`. */
  path: string;
  reason: string;
}

/**
 * The definition of "JSON-safe" this contract enforces: a value built only from
 * `null`, booleans, strings, **finite** numbers, arrays, and plain objects (own
 * prototype `Object.prototype` or `null`), with no cycles and no own
 * `__proto__` key. Returns the first problem found, or null.
 *
 * It **refuses** rather than normalizes, and that is the point. The obvious
 * alternative — `JSON.parse(JSON.stringify(x))` — does not reject these values,
 * it silently rewrites them: `undefined` object properties vanish, `NaN` and
 * `Infinity` become `null`, a `Date` becomes a string, a `Map` becomes `{}`.
 * Only cycles and `BigInt` actually throw. A producer that sent a `Date` meant
 * a `Date`; handing it back a string and reporting success is the exact failure
 * this contract exists to prevent, so the producer is told instead.
 *
 * Why it matters even though a backup arrives via `JSON.parse` (and so is
 * JSON-safe almost by construction): the capture path does not. A record that
 * crosses `postMessage` or `chrome.runtime` is structured-cloned, which happily
 * carries `Date`s, `Map`s and cycles — and a function or symbol among them
 * makes IndexedDB's own clone throw `DataCloneError` mid-write.
 */
export function findJsonSafetyProblem(
  value: unknown,
  path: string,
  stack: Set<object> = new Set(),
): JsonSafetyProblem | null {
  if (value === null || typeof value !== "object") return findScalarJsonProblem(value, path);

  // A path-stack, not a visited-set: an object reached twice down DIFFERENT
  // branches is a DAG and perfectly serialisable, so it is removed on the way
  // back up. Only an object that contains itself is a cycle.
  if (stack.has(value)) return { path, reason: "a circular reference has no JSON representation" };
  stack.add(value);
  try {
    return findContainerJsonProblem(value, path, stack);
  } finally {
    stack.delete(value);
  }
}

/**
 * The terminal half of {@link findJsonSafetyProblem}'s dispatch — every value
 * that is `null` or a non-`object` `typeof`. Split out so neither half carries
 * the other's branch count; there is nothing here to recurse into, so each case
 * returns a verdict directly.
 */
function findScalarJsonProblem(value: unknown, path: string): JsonSafetyProblem | null {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return null;
    case "number":
      return Number.isFinite(value)
        ? null
        : { path, reason: `${String(value)} has no JSON representation` };
    case "bigint":
      return { path, reason: "a BigInt has no JSON representation" };
    case "function":
      return { path, reason: "a function has no JSON representation" };
    case "symbol":
      return { path, reason: "a symbol has no JSON representation" };
    default:
      // `undefined` — `object` is excluded by the only caller's guard.
      return { path, reason: "undefined has no JSON representation" };
  }
}

/**
 * The recursive half — arrays and plain objects, walked element by element.
 * Called only with the cycle stack already holding `object`, so it recurses
 * through {@link findJsonSafetyProblem} rather than itself and the push/pop
 * stays in one place.
 */
function findContainerJsonProblem(
  object: object,
  path: string,
  stack: Set<object>,
): JsonSafetyProblem | null {
  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      const problem = findJsonSafetyProblem(object[i], `${path}[${i}]`, stack);
      if (problem) return problem;
    }
    return null;
  }
  if (!isPlainObject(object)) {
    // `Object.prototype.toString` rather than `.constructor` — no property
    // read on a value we have already decided we do not trust.
    const tag = Object.prototype.toString.call(object).slice(8, -1);
    return { path, reason: `a ${tag} is not a plain JSON object` };
  }
  for (const key of Object.keys(object)) {
    if (key === FORBIDDEN_KEY) {
      return { path: `${path}.${FORBIDDEN_KEY}`, reason: "a `__proto__` key is not accepted" };
    }
    const problem = findJsonSafetyProblem(object[key], `${path}.${key}`, stack);
    if (problem) return problem;
  }
  return null;
}

/**
 * Run every {@link JOB_RECORD_RULES} entry against `value`, returning the
 * refusal reasons and the subset of fields that passed their guard.
 *
 * Split out of {@link validateJobRecord} so the rule loop's branch count sits
 * on its own: an absent-but-required field, a present-but-wrong field and a
 * field with a bespoke `explain` are three shapes, and reading them beside the
 * warning and extras passes was what pushed the caller over the complexity bar.
 */
function checkDeclaredFields(value: Record<string, unknown>): {
  reasons: JobRecordIssue[];
  checked: Record<string, unknown>;
} {
  const reasons: JobRecordIssue[] = [];
  const checked: Record<string, unknown> = {};

  for (const field of Object.keys(JOB_RECORD_RULES)) {
    // The map's value type is a union of `FieldRule<T>` for every field's own
    // `T`, which is exactly what makes the drift guard bite at compile time.
    // A store-agnostic loop can't hold that union, so it reads each rule
    // through the erased boolean-returning shape — the narrowing is the
    // declaration's job, not this loop's.
    const rule = JOB_RECORD_RULES[field as keyof JobRecord] as {
      required: boolean;
      check: (value: unknown) => boolean;
      expected: string;
      explain?: (value: unknown) => string | undefined;
    };
    const present = hasOwn(value, field) && value[field] !== undefined;
    if (!present) {
      if (rule.required) reasons.push(`\`${field}\` is required and must be ${rule.expected}.`);
      continue;
    }
    if (!rule.check(value[field])) {
      reasons.push(
        rule.explain?.(value[field]) ?? `\`${field}\` must be ${rule.expected}.`,
      );
      continue;
    }
    checked[field] = value[field];
  }

  return { reasons, checked };
}

/**
 * Warnings, not refusals: these run only on values that already passed their
 * guard, so each names a record we ACCEPTED with something a caller should say
 * out loud. See the decision notes on `isStatusLike` and `isUrlLike`.
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
  return warnings;
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
 * (see {@link FORBIDDEN_KEY}) — it is never a forward-compatible field.
 *
 * ## What is repaired rather than refused
 *
 * An absent `status` becomes `"interested"`, matching `createJob`'s documented
 * default, so a producer that omits a lifecycle it has no opinion about is not
 * punished for it. Nothing else is rewritten.
 */
export function validateJobRecord(value: unknown): JobRecordValidation {
  if (!isPlainObject(value)) {
    return { ok: false, reasons: ["A job record must be a plain JSON object."] };
  }
  if (hasOwn(value, FORBIDDEN_KEY)) {
    return { ok: false, reasons: ["A job record must not carry a `__proto__` key."] };
  }

  const { reasons, checked } = checkDeclaredFields(value);
  const warnings = collectAcceptedWarnings(checked);

  if (reasons.length > 0) return { ok: false, reasons };

  // Extras are gathered only after the record is otherwise accepted — a refused
  // record has nothing to preserve. They are held to the same JSON-safety bar
  // as `matchResult`: a preserved key that can't survive the next export would
  // be preservation in name only.
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) extras[key] = value[key];
  }
  const extraProblem = findJsonSafetyProblem(extras, "record");
  if (extraProblem) {
    return { ok: false, reasons: [`\`${extraProblem.path}\`: ${extraProblem.reason}.`] };
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

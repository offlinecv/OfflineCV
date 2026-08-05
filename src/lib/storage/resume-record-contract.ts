// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The runtime half of the résumé record contract (#757) — the gate an
 * externally-authored {@link ResumeRecord} passes through on its way into
 * IndexedDB via a restored backup file.
 *
 * `resumes` was the one store `importAll` wrote with no validation at all,
 * while `jobs` (`job-record-contract.ts`) and `letters` (`letter-contract.ts`)
 * both go through a contract built on the same shared machinery,
 * `record-contract.ts`. This module closes that gap, mirroring
 * `letter-contract.ts` — the smaller and closer of the two existing models —
 * rather than hand-rolling a fourth checking style.
 *
 * ## `blob` is not part of this contract
 *
 * `ExportedResume` (the shape a candidate actually arrives in) replaces
 * `ResumeRecord.blob` with `blobBase64`/`blobType`; `importAll` decodes those
 * back into a `Blob` and attaches it AFTER a candidate clears this contract.
 * `Blob` is not JSON-safe and was never going to survive `findJsonSafetyProblem`
 * anyway, so the two string fields are validated at the call site in
 * `backup.ts`, next to where the decode happens, rather than here.
 *
 * ## `parse` is validated as JSON-safe, not as a `SavedResumeSnapshot`
 *
 * `resume-library.ts`'s own docblock states the boundary this module has to
 * respect: storage "holds the parse as an opaque `parse` payload" — the
 * `SavedResumeSnapshot` shape (`result`/`score`/`sourceKind`/`shapeVersion`)
 * belongs to `resume-library.ts`, one layer up, and is not this module's to
 * assert. What this layer owns is the promise `record-contract.ts` states for
 * every field it checks: *is this safe to put in an object store?* — a plain
 * object, JSON-safe, no own `__proto__` key. A `parse` that clears this bar but
 * still can't be read as a snapshot (missing `result`/`score`) is not refused
 * here; it round-trips, and `resume-library.ts#listLibrary`'s `hasCachedParse`
 * is where that distinction is made and reported to the user — a decision that
 * layer owns, not this one.
 *
 * `parse: null` is normalized to absent before the rules run: `readSnapshot`
 * treats `parse == null` as "no snapshot" via optional chaining, so a record
 * that explicitly says `"parse": null` describes the same legal state as one
 * that omits the key, and should not be refused for failing the object check.
 *
 * ## The drift guard
 *
 * {@link RESUME_RECORD_RULES} is a mapped type over
 * `keyof Required<Omit<ResumeRecord, "blob">>`, so adding a field to
 * `ResumeRecord` (other than `blob`, deliberately excluded above) without a
 * rule for it fails `tsc`, and a rule with the wrong guard fails `tsc` too —
 * the same guard `job-record-contract.ts` documents at length.
 *
 * ## Why there is no `warnings` channel
 *
 * Same reasoning as `letter-contract.ts`: nothing here is accepted-but-suspect
 * the way an out-of-union `JobStatus` or a non-absolute `url` is. A résumé
 * accepted without a cached `parse` is not a warning about a wrong value — it
 * is a legal, common shape (every record `#693`'s capture door writes has one),
 * and `backup.ts` counts it directly off the accepted list rather than reading
 * it back out of a per-record warning.
 */

import type { ResumeRecord } from "./types.ts";
import {
  checkDeclaredFields,
  collectJsonSafeExtras,
  explainJsonSafety,
  findJsonSafetyProblem,
  hasOwn,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  FORBIDDEN_KEY,
  type FieldRule,
} from "./record-contract.ts";

/** A reason a résumé was refused. One sentence, addressed to whoever has to
 *  fix the producer or the file. */
export type ResumeRecordIssue = string;

/** The fields this contract validates — every `ResumeRecord` field except
 *  `blob`, which is reconstructed from `blobBase64`/`blobType` at the call
 *  site (see the module docblock). */
export type ResumeRecordFields = Omit<ResumeRecord, "blob">;

/** Outcome of validating one candidate résumé. See the module docblock for why
 *  the success branch has no `warnings`. */
export type ResumeRecordValidation =
  | { ok: true; record: ResumeRecordFields }
  | { ok: false; reasons: ResumeRecordIssue[] };

/**
 * `parse`'s real type is `unknown` (opaque by design), so this checks exactly
 * what `record-contract.ts` checks everywhere else an opaque field rides
 * through unexamined — `matchResult` on a job, an extra key on either
 * contract: a plain object, and JSON-safe all the way down (which also catches
 * a nested own `__proto__`). See the module docblock for why it does not also
 * require `result`/`score`.
 */
const isReadableParseSnapshot = (value: unknown): value is unknown =>
  isPlainObject(value) && findJsonSafetyProblem(value, "parse") === null;

/**
 * One rule per résumé field (minus `blob`). See the drift-guard note in the
 * module docblock — the mapped type, not this list, is what keeps it complete.
 *
 * `createdAt` / `updatedAt` are optional because `putRecord` owns them, the
 * same reason the job and letter contracts leave them optional. `deletedAt` is
 * included for the same structural reason `LetterRecord`'s is — `StoredRecord`
 * declares it on every record — even though nothing in this build ever writes
 * one onto a résumé (`resumes` hard-deletes; see `backup.ts`'s module
 * docblock). A file could still carry one from an outside producer, and a
 * finite epoch-ms number costs nothing to accept.
 */
export const RESUME_RECORD_RULES: {
  [K in keyof Required<ResumeRecordFields>]: FieldRule<Required<ResumeRecordFields>[K]>;
} = {
  id: { required: true, check: isNonEmptyString, expected: "a non-empty string" },
  createdAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  updatedAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  deletedAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  filename: { required: true, check: isNonEmptyString, expected: "a non-empty string" },
  parse: {
    required: false,
    check: isReadableParseSnapshot,
    expected: "a plain, JSON-safe object",
    explain: (value) => explainJsonSafety(value, "parse"),
  },
};

/** Field names the rules cover — everything else on an incoming record is an
 *  unknown extra key. */
const KNOWN_FIELDS = new Set(Object.keys(RESUME_RECORD_RULES));

/**
 * Validate one candidate résumé (already stripped of `blobBase64`/`blobType`
 * by the caller) and return it in the shape the store accepts.
 *
 * Unknown extra keys are **preserved**, and an own `__proto__` key refuses the
 * record outright — the same two rules `validateJobRecord` documents at
 * length, for the same reasons.
 */
export function validateResumeRecord(value: unknown): ResumeRecordValidation {
  if (!isPlainObject(value)) {
    return { ok: false, reasons: ["A resume record must be a plain JSON object."] };
  }
  if (hasOwn(value, FORBIDDEN_KEY)) {
    return { ok: false, reasons: ["A resume record must not carry a `__proto__` key."] };
  }

  // See the module docblock: `parse: null` reads as "no snapshot" everywhere
  // else this record is read, so it is normalized to absent before the
  // presence check below would otherwise refuse it as a non-object `parse`.
  const candidate = value.parse === null ? { ...value, parse: undefined } : value;

  const { reasons, checked } = checkDeclaredFields(candidate, RESUME_RECORD_RULES);
  if (reasons.length > 0) return { ok: false, reasons };

  // Only once the record is otherwise accepted — a refused record has nothing
  // to preserve, and a preserved key that can't survive the next export would
  // be preservation in name only.
  const { extras, problem } = collectJsonSafeExtras(candidate, KNOWN_FIELDS);
  if (problem) {
    return { ok: false, reasons: [`\`${problem.path}\`: ${problem.reason}.`] };
  }

  // `id` and `filename` were just proved to be strings by the rules map, but
  // `checked` is an erased `Record<string, unknown>`, so that proof lives in
  // the map rather than in a type the compiler can follow from here. Asserted
  // through `unknown` because an index-signature type structurally overlaps
  // nothing.
  return { ok: true, record: { ...extras, ...checked } as unknown as ResumeRecordFields };
}

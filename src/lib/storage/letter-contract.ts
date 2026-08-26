// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The runtime half of the cover-letter contract (#711) — the gate an
 * externally-authored {@link LetterRecord} passes through on its way into
 * IndexedDB.
 *
 * `letters` is the first store whose records this build never writes: #711
 * defines the artifact and refuses to pin it to a generator. Every real writer
 * is therefore outside the typechecker's reach — a Claude Code skill running JS
 * in the page's own origin, the browser extension later, a hosted tier if that
 * path is ever taken — which is exactly the situation `job-record-contract.ts`
 * was retrofitted into. Letters get the validator on day one instead.
 *
 * The prose half is `docs/cover-letter-contract.md`. It is normative for
 * producers; this module must never disagree with it. The shared machinery is
 * `record-contract.ts`, and the drift guard is the same one the job contract
 * documents at length: {@link LETTER_RECORD_RULES} is a mapped type over
 * `keyof Required<LetterRecord>`, so adding a field to `LetterRecord` without a
 * rule for it fails `tsc`, and giving a field the wrong guard fails `tsc` too.
 *
 * ## Why there is no `warnings` channel
 *
 * `JobRecordValidation` carries one because a job has two fields that are
 * accepted-but-suspect: a `status` outside a closed vocabulary, and a `url`
 * that is not absolute but is about to be rendered into an `href`. A letter has
 * neither — no closed vocabulary, nothing rendered as a link, no field whose
 * value is preserved verbatim against this build's judgement. An always-empty
 * warnings array would be dead surface pretending to be symmetry, so the
 * success branch is just the record.
 */

import type { LetterRecord, LetterProvenance } from "./types.ts";
import {
  checkDeclaredFields,
  collectJsonSafeExtras,
  explainJsonSafety,
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
 * Contract version a producer targets, carried on `LetterRecord.producer.contract`.
 *
 * Independent of `StorageExport.version` (the backup DOCUMENT format) and of
 * `JOB_CAPTURE_CONTRACT_VERSION` (a different record): a letter outlives the
 * file it arrived in, and the letter contract will move for reasons the job
 * contract does not share. Absent provenance means "written by this app against
 * version 1".
 *
 * Exported as part of the contract SURFACE, not awaiting a caller: §6 of
 * `docs/cover-letter-contract.md` is normative for reimplementers and this is
 * the number it tells them to send. Nothing in this build reads it, by design —
 * the validator requires `producer.contract` to be a finite number and does not
 * compare it against this constant, because refusing a record from a future
 * version is the forward-compatibility failure §6 exists to avoid.
 *
 * `2` since #766: `jobId` became optional and `companyKey` joined it. The bump
 * says a producer MAY send more, not that it must — one that always sends
 * `jobId` and never sends `companyKey` is a valid v2 producer that happens to
 * write only job letters, and nothing here refuses it or asks it to change.
 */
export const LETTER_CONTRACT_VERSION = 2;

/** A reason a letter was refused. One sentence, addressed to whoever has to fix
 *  the producer or the file. */
export type LetterRecordIssue = string;

/** Outcome of validating one candidate letter. See the module docblock for why
 *  the success branch has no `warnings`. */
export type LetterRecordValidation =
  | { ok: true; record: LetterRecord }
  | { ok: false; reasons: LetterRecordIssue[] };

const isLetterProvenance = (value: unknown): value is LetterProvenance =>
  isProvenanceLike(value, "generatedAt", "producer");

/**
 * One rule per `LetterRecord` field. The mapped type, not this list, is what
 * keeps it complete — see the module docblock.
 *
 * `body` is `required` but checked with `isString`, not `isNonEmptyString`: an
 * empty draft is a legitimate state (a producer that created the record before
 * filling it, a user who cleared the text), and refusing it would make the
 * store unable to hold something the user can plainly see.
 *
 * The two SCOPE keys are the opposite (#766). Both are optional — their three
 * combinations are what give a letter its scope, and the lattice is documented
 * on {@link LetterRecord.jobId} — but each is `isNonEmptyString`, so `""` is a
 * refusal and absent is the only way to say "not scoped by this". Were `""`
 * accepted it would be a silent fourth state that reads as set to every
 * `hasOwn` check and as unset to every comparison. The one combination the
 * rules map cannot express — BOTH keys set — is a cross-field rule and is
 * checked in {@link validateLetterRecord} instead.
 *
 * `createdAt` / `updatedAt` are optional because `putRecord` owns them: a
 * backup carries them (so `createdAt` survives a restore) and a fresh write
 * omits them. Present-but-not-a-number is still a refusal — a drafts list sorts
 * on `updatedAt`.
 */
export const LETTER_RECORD_RULES: {
  [K in keyof Required<LetterRecord>]: FieldRule<Required<LetterRecord>[K]>;
} = {
  id: { required: true, check: isNonEmptyString, expected: "a non-empty string" },
  createdAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  updatedAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  // A tombstone (#730) — the same rule the job contract carries, for the same
  // reason: the export document holds deletions so a restore does not resurrect
  // them. See §5 of the contract doc.
  deletedAt: { required: false, check: isFiniteNumber, expected: "a finite epoch-ms number" },
  jobId: { required: false, check: isNonEmptyString, expected: "a non-empty string" },
  companyKey: { required: false, check: isNonEmptyString, expected: "a non-empty string" },
  resumeId: { required: false, check: isNonEmptyString, expected: "a non-empty string" },
  body: { required: true, check: isString, expected: "a string" },
  label: { required: false, check: isString, expected: "a string" },
  producer: {
    required: false,
    check: isLetterProvenance,
    expected: "an object with a finite `contract` number",
    explain: (value) => explainJsonSafety(value, "producer"),
  },
};

/** Field names the rules cover — everything else on an incoming record is an
 *  unknown extra key. */
const KNOWN_FIELDS = new Set(Object.keys(LETTER_RECORD_RULES));

/**
 * Validate one candidate letter and return it in the shape the store accepts.
 *
 * Unknown extra keys are **preserved**, and an own `__proto__` key refuses the
 * record outright — the same two rules `validateJobRecord` documents at length,
 * for the same reasons (dropping unknown keys makes export → import → export
 * silently lossy across versions; `JSON.parse` turns `__proto__` into a real
 * own property and no legitimate producer emits it).
 *
 * Nothing is repaired. The job contract defaults an absent `status` because it
 * has a lifecycle a producer can reasonably have no opinion about; a letter has
 * no such field, so every refusal here is a genuine "this record is not one".
 *
 * The one rule here that is not in {@link LETTER_RECORD_RULES} is the both-keys
 * refusal (#766), and it is here because it is CROSS-FIELD: a rules map judges
 * one value at a time and neither key is wrong on its own. It runs after
 * `checkDeclaredFields` so a record that is malformed *and* over-scoped is told
 * about its malformed field first, rather than being handed a scope complaint
 * about a `jobId` that was never a string.
 */
export function validateLetterRecord(value: unknown): LetterRecordValidation {
  if (!isPlainObject(value)) {
    return { ok: false, reasons: ["A letter record must be a plain JSON object."] };
  }
  if (hasOwn(value, FORBIDDEN_KEY)) {
    return { ok: false, reasons: ["A letter record must not carry a `__proto__` key."] };
  }

  const { reasons, checked } = checkDeclaredFields(value, LETTER_RECORD_RULES);
  if (reasons.length > 0) return { ok: false, reasons };

  // Scope is a three-case lattice — job, company, or standard — and both keys
  // set is none of them. Refused rather than resolved by precedence: a producer
  // that sent both cannot be told which one this build would have honoured, so
  // picking one would file the letter somewhere it never asked for. `checked`
  // rather than `value` because a key present as `undefined` is absent.
  if (checked.jobId !== undefined && checked.companyKey !== undefined) {
    return {
      ok: false,
      reasons: [
        "A letter record must not carry both `jobId` and `companyKey`: a letter is scoped to one job, or to one company, or to neither (a standard letter).",
      ],
    };
  }

  // Only once the record is otherwise accepted — a refused record has nothing
  // to preserve, and a preserved key that can't survive the next export would
  // be preservation in name only.
  const { extras, problem } = collectJsonSafeExtras(value, KNOWN_FIELDS);
  if (problem) {
    return { ok: false, reasons: [`\`${problem.path}\`: ${problem.reason}.`] };
  }

  // `id` and `body` were just proved to be strings, and the store owns
  // `createdAt` / `updatedAt` (see `putRecord`) — but `checked` is an erased
  // `Record<string, unknown>`, so that proof lives in the rules map rather than
  // in a type the compiler can follow from here. Asserted through `unknown`
  // because an index-signature type structurally overlaps nothing.
  return { ok: true, record: { ...extras, ...checked } as unknown as LetterRecord };
}

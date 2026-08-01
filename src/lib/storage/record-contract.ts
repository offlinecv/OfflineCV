// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The machinery both record contracts are built from — the job capture contract
 * (#693, `job-record-contract.ts`) and the cover-letter contract (#711,
 * `letter-contract.ts`).
 *
 * It exists because those two files answer the same question about different
 * records: *is this externally-authored object safe to put in an object store?*
 * The answer has one shape — a rules map typed over the record's own fields, a
 * JSON-safety walk, and a preserve-unknown-keys pass — and duplicating it would
 * produce the exact failure the drift-guard note in `job-record-contract.ts`
 * warns about, twice over: a second copy that quietly stops matching the first.
 *
 * Nothing here knows what a job or a letter is. Everything record-specific —
 * which fields exist, which are required, what is repaired, what is merely
 * warned about — stays in the contract module that owns that record, next to
 * the prose doc that is normative for its producers.
 */

/** A type predicate over `unknown`, narrowing to one field's declared type. */
export type Guard<T> = (value: unknown) => value is T;

export interface FieldRule<T> {
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

/**
 * A {@link FieldRule} with its type parameter erased — what a store-agnostic
 * loop can hold.
 *
 * A rules map's declared value type is a UNION of `FieldRule<T>` for every
 * field's own `T`, and that union is exactly what makes the drift guard bite at
 * compile time. {@link checkDeclaredFields} cannot hold it, so it reads each
 * rule through this shape instead: the narrowing is the map declaration's job,
 * not the loop's. A `Guard<T>` is assignable to `(value: unknown) => boolean`,
 * so passing a well-typed rules map here needs no cast.
 */
export interface ErasedFieldRule {
  required: boolean;
  check: (value: unknown) => boolean;
  expected: string;
  explain?: (value: unknown) => string | undefined;
}

export const isString = (value: unknown): value is string => typeof value === "string";

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Own-key name refused wherever it appears. `JSON.parse` turns `"__proto__"`
 * into a real own property, and a later `Object.assign`-style merge would then
 * reach the prototype setter. No legitimate producer emits it. `constructor` is
 * deliberately allowed: shadowing it on a plain data object is inert here
 * (nothing reads `record.constructor`), and refusing a plausible field name
 * costs a producer more than it buys.
 */
export const FORBIDDEN_KEY = "__proto__";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Where a value stopped being JSON-safe, and why. */
export interface JsonSafetyProblem {
  /** Dotted/bracketed path from the value's root, e.g. `matchResult.rows[2].score`. */
  path: string;
  reason: string;
}

/**
 * The definition of "JSON-safe" these contracts enforce: a value built only from
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

/** A {@link FieldRule.explain} body for any field whose real check is JSON
 *  safety — names the failing path instead of repeating `expected`. */
export function explainJsonSafety(value: unknown, path: string): string | undefined {
  const problem = findJsonSafetyProblem(value, path);
  return problem ? `\`${problem.path}\`: ${problem.reason}.` : undefined;
}

/**
 * Both record contracts carry a provenance object with the same three
 * producer-identifying fields (`contract`, `producer`, `producerVersion`) and
 * one contract-specific timestamp — `capturedAt` on a job, `generatedAt` on a
 * letter. Only `contract` is required, and only its absence or a wrong type is
 * a refusal; unknown extra keys inside the object ride through, held to the
 * same JSON-safety bar as everything else.
 *
 * Returns a plain boolean rather than a predicate: the concrete provenance type
 * differs per contract, so each caller wraps this in its own one-line `value is
 * T` guard.
 */
export function isProvenanceLike(
  value: unknown,
  timestampKey: string,
  path: string,
): boolean {
  if (!isPlainObject(value)) return false;
  if (!isFiniteNumber(value.contract)) return false;
  for (const key of ["producer", "producerVersion"]) {
    if (value[key] !== undefined && !isString(value[key])) return false;
  }
  if (value[timestampKey] !== undefined && !isFiniteNumber(value[timestampKey])) return false;
  return findJsonSafetyProblem(value, path) === null;
}

/**
 * Run every rule in `rules` against `value`, returning the refusal reasons and
 * the subset of fields that passed their guard.
 *
 * Split out of the per-contract `validate…` functions so the rule loop's branch
 * count sits on its own: an absent-but-required field, a present-but-wrong field
 * and a field with a bespoke `explain` are three shapes, and reading them beside
 * the warning and extras passes was what pushed the caller over the complexity
 * bar.
 */
export function checkDeclaredFields(
  value: Record<string, unknown>,
  rules: Record<string, ErasedFieldRule>,
): { reasons: string[]; checked: Record<string, unknown> } {
  const reasons: string[] = [];
  const checked: Record<string, unknown> = {};

  for (const [field, rule] of Object.entries(rules)) {
    const present = hasOwn(value, field) && value[field] !== undefined;
    if (!present) {
      if (rule.required) reasons.push(`\`${field}\` is required and must be ${rule.expected}.`);
      continue;
    }
    if (!rule.check(value[field])) {
      reasons.push(rule.explain?.(value[field]) ?? `\`${field}\` must be ${rule.expected}.`);
      continue;
    }
    checked[field] = value[field];
  }

  return { reasons, checked };
}

/**
 * Gather the keys no rule covers, and check they could survive the next export.
 *
 * Unknown keys are PRESERVED by both contracts — dropping them would make an
 * export → import → export cycle silently lossy for a user who moves a backup
 * between two offlinecv versions. But a preserved key whose value can't be
 * serialised would be preservation in name only, so the extras are held to the
 * same JSON-safety bar as any opaque declared field.
 *
 * Call this only once a record is otherwise accepted: a refused record has
 * nothing to preserve.
 */
export function collectJsonSafeExtras(
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
): { extras: Record<string, unknown>; problem: JsonSafetyProblem | null } {
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) extras[key] = value[key];
  }
  return { extras, problem: findJsonSafetyProblem(extras, "record") };
}

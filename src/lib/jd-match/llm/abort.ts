// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * abort.ts — cancellation helpers for the semantic JD-match pipeline (#803).
 *
 * The narrow `WebLlmEngine` in `types.ts` exposes only `chat.completions.create()`
 * and no per-request cancellation. `MLCEngine.interruptGenerate()` DOES exist
 * on the real `@mlc-ai/web-llm` engine, but it is engine-scoped rather than
 * request-scoped — calling it would cancel every concurrent completion on that
 * shared engine, including ones started by other consumers on the same page
 * (e.g. `job-search/sector.ts`, per #148's whole raison d'être). That would
 * violate #803's own requirement not to "cancel another consumer's work", so we
 * deliberately do NOT use it.
 *
 * Cancellation is therefore BOUNDARY-based: each stage / batch checks
 * `signal.aborted` before starting and after resolving. The residual wasted
 * work an abandoned run can do is bounded by the one LLM call that is already
 * in flight when the abort fires — that call runs to completion; no subsequent
 * stage or batch is scheduled. This is exactly the bound #803's own "Proposed
 * approach" §2 describes.
 *
 * We use the fetch-API convention (`DOMException` with `name === "AbortError"`)
 * so the error we throw here is shape-identical to what
 * `AbortSignal.prototype.throwIfAborted()` produces on browsers and Node ≥ 17.
 * That means `isAbortError` is a single check regardless of whether the abort
 * came from an explicit `throwIfAborted()`, a fetch-shaped consumer, or our
 * own `abortError()` factory. Not thrown from a fetch, so a `signal.reason`
 * value is not preserved — the shape (not the message) is what downstream
 * catches key off.
 */

/**
 * Construct a fetch-standard AbortError so downstream catches can key off
 * `err.name === "AbortError"` regardless of source.
 *
 * Kept as a factory (not a shared instance) so the stack trace points at the
 * abort site rather than at this module's load time — matters when diagnosing
 * why a stage bailed.
 */
export function abortError(reason?: string): DOMException {
  return new DOMException(reason ?? "Semantic run aborted.", "AbortError");
}

/**
 * True for anything shaped like an AbortError: our own `abortError()`, a
 * DOMException from `AbortSignal.throwIfAborted()`, or any object with
 * `name === "AbortError"` (the fetch-API contract). Deliberately structural
 * rather than `instanceof DOMException` so it survives realms where the
 * `DOMException` constructor identity differs (jsdom vs. node vs. workers).
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

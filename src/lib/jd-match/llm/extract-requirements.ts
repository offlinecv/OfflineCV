// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * extract-requirements.ts — LLM call #1 of the semantic JD-match path (#200).
 *
 * Turns raw JD text into a typed `JdRequirement[]` via an on-device model. The
 * engine is caller-owned (loaded, with acquire/release managed by the caller, as
 * in `parse-resume.ts` / `critique-resume.ts`) — this module is pure extraction
 * glue and never touches `web-llm.ts`.
 *
 * Failure model: on a hard failure (engine error, or output that yields no
 * parseable JSON array) it THROWS `RequirementExtractionError`, so the future
 * orchestrator can fall back to the deterministic keyword path. A valid empty
 * array — the model legitimately found no requirements — is NOT a failure; it
 * returns `[]`. That distinction is the whole reason this throws rather than
 * returning `[]` on error.
 *
 * Cancellation (#803): accepts an optional `AbortSignal`. Checked BEFORE the
 * engine call (already-aborted → don't start the LLM at all) and AFTER it
 * resolves (aborted during the call → don't run the coercion pass or hand
 * results back to the orchestrator). An aborted call throws a fetch-shaped
 * `AbortError` DOMException that the orchestrator distinguishes from a
 * `RequirementExtractionError`: abort is expected control flow that resolves
 * to the keyword fallback silently; RequirementExtractionError is a real
 * failure that logs a warning. The engine's own call is NOT interrupted —
 * see `abort.ts` for why we can't safely `interruptGenerate()` a shared
 * engine — so the residual wasted work is bounded to the currently in-flight
 * completion.
 */

import type { WebLlmEngine } from "../../webllm/types.ts";
import { tryParseJsonArray } from "../../webllm/json-repair.ts";
import { abortError, isAbortError } from "./abort.ts";
import {
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserPrompt,
} from "./prompts.ts";

export interface JdRequirement {
  /** Stable, sequential slug ("req-1", "req-2", …) that joins extract → judge. */
  id: string;
  /** Semantic category of the requirement. */
  kind: "skill" | "experience" | "responsibility" | "qualification";
  /** Normalized one-sentence requirement text. */
  text: string;
  /**
   * Minimum years of experience, when the JD states an explicit count. The
   * model-facing key is `"years"`; the judge call (#201) reads this same field.
   */
  years?: number;
}

/**
 * Thrown when extraction hard-fails (engine error, or output with no parseable
 * JSON array). The orchestrator catches this and falls back to the keyword path.
 */
export class RequirementExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementExtractionError";
  }
}

const REQUIREMENT_KINDS = new Set<string>([
  "skill",
  "experience",
  "responsibility",
  "qualification",
]);

/** Headroom for ~30 requirements at ~30 tokens each, plus structure. */
const MAX_TOKENS = 1024;

/**
 * Extract structured requirements from a job description.
 *
 * @param signal — optional AbortSignal. Checked pre-call (skips the engine
 *   entirely) and post-call (skips the coercion pass and propagates the
 *   abort back to the orchestrator). Aborts throw an AbortError DOMException
 *   distinct from `RequirementExtractionError`.
 * @throws {RequirementExtractionError} on engine failure or unparseable output.
 * @throws {DOMException} with `name === "AbortError"` when `signal` fires.
 */
export async function extractRequirements(
  jdText: string,
  engine: WebLlmEngine,
  signal?: AbortSignal,
): Promise<JdRequirement[]> {
  // Pre-check: an already-aborted signal must never trigger the expensive
  // LLM call. This is the boundary #803's "check before starting the
  // expensive LLM call" acceptance criterion targets.
  if (signal?.aborted) {
    throw abortError("Semantic run aborted before requirement extraction.");
  }

  let content: string;
  try {
    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildExtractUserPrompt(jdText) },
      ],
      temperature: 0,
      max_tokens: MAX_TOKENS,
    });
    content = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    // If the completion itself was rejected by an AbortError (e.g. a future
    // signal-aware engine) AND our signal is what fired, propagate the abort
    // AS-IS rather than wrapping it as a RequirementExtractionError — the
    // orchestrator distinguishes them. The `signal?.aborted` half is
    // load-bearing: without it an engine-originated `AbortError` on an unfired
    // signal is re-thrown into the orchestrator's silent cancellation branch
    // and the real failure leaves no diagnostic trail (see `abort.ts`).
    if (isAbortError(err) && signal?.aborted) throw err;
    throw new RequirementExtractionError(
      `Requirement extraction engine call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Post-check: abort fired DURING the completion. The engine call already
  // ran (we can't interrupt a shared engine — see abort.ts), but the coercion
  // pass and any downstream consumer that would act on this result must not.
  if (signal?.aborted) {
    throw abortError("Semantic run aborted during requirement extraction.");
  }

  const parsed = tryParseJsonArray(content);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    throw new RequirementExtractionError(
      "Requirement extraction returned no parseable JSON array",
    );
  }

  return coerceRequirements(parsed.value);
}

/** Coerce a raw array into typed requirements, dropping unusable entries. */
function coerceRequirements(items: unknown[]): JdRequirement[] {
  const out: JdRequirement[] = [];
  for (const raw of items) {
    // Number ids off the OUTPUT position so surviving requirements always carry
    // a contiguous, unique `req-N` (the extract → judge join key). The model's
    // own `id` is deliberately ignored — small models emit duplicate or gapped
    // ids, which would silently collide the join in the judge call (#201).
    const requirement = coerceRequirement(raw, out.length);
    if (requirement !== null) out.push(requirement);
  }
  return out;
}

/**
 * Coerce one raw element into a `JdRequirement`, or `null` to drop it. An entry
 * with no usable `text` is dropped; an unknown `kind` defaults to `"skill"`; the
 * `id` is assigned deterministically from `outputIndex` (see `coerceRequirements`).
 * Field-level coercion lives in the small helpers below (house style — cf.
 * `parse-resume.ts` `coerceString` / `coerceStringArray`).
 */
function coerceRequirement(
  raw: unknown,
  outputIndex: number,
): JdRequirement | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const text = coerceText(obj["text"]);
  if (text === null) return null;

  const id = `req-${outputIndex + 1}`;
  const kind = coerceKind(obj["kind"]);
  const years = coerceYears(obj["years"]);

  return years !== undefined
    ? { id, kind, text, years }
    : { id, kind, text };
}

/** Trimmed non-empty requirement text, or `null` when absent/blank. */
function coerceText(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.length > 0 ? text : null;
}

/** A valid requirement kind, defaulting unknown/missing values to `"skill"`. */
function coerceKind(raw: unknown): JdRequirement["kind"] {
  return typeof raw === "string" && REQUIREMENT_KINDS.has(raw)
    ? (raw as JdRequirement["kind"])
    : "skill";
}

/** An integer year count when the model gave a finite number, else `undefined`. */
function coerceYears(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.trunc(raw)
    : undefined;
}

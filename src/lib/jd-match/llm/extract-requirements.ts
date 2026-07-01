// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 */

import type { WebLlmEngine } from "../../webllm/types.ts";
import { parseJsonLoose } from "./parse-json.ts";
import {
  EXTRACT_REQUIREMENTS_SYSTEM_PROMPT,
  buildExtractRequirementsUserPrompt,
} from "./prompts.ts";

export interface JdRequirement {
  /** Stable, sequential slug ("req-1", "req-2", …) that joins extract → judge. */
  id: string;
  /** Normalized one-sentence requirement text. */
  text: string;
  /** Semantic category of the requirement. */
  kind: "skill" | "experience" | "responsibility" | "qualification";
  /** Minimum years of experience, when the JD states an explicit count. */
  yearsRequired?: number;
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
 * @throws {RequirementExtractionError} on engine failure or unparseable output.
 */
export async function extractRequirements(
  jdText: string,
  engine: WebLlmEngine,
): Promise<JdRequirement[]> {
  let content: string;
  try {
    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: EXTRACT_REQUIREMENTS_SYSTEM_PROMPT },
        { role: "user", content: buildExtractRequirementsUserPrompt(jdText) },
      ],
      temperature: 0,
      max_tokens: MAX_TOKENS,
    });
    content = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    throw new RequirementExtractionError(
      `Requirement extraction engine call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const parsed = parseJsonLoose(content);
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
  for (let i = 0; i < items.length; i++) {
    const requirement = coerceRequirement(items[i], i);
    if (requirement !== null) out.push(requirement);
  }
  return out;
}

/**
 * Coerce one raw element into a `JdRequirement`, or `null` to drop it. An entry
 * with no usable `text` is dropped; an unknown `kind` defaults to `"skill"`; a
 * missing `id` is backfilled deterministically from its position. Field-level
 * coercion lives in the small helpers below (house style — cf. `parse-resume.ts`
 * `coerceString` / `coerceStringArray`).
 */
function coerceRequirement(raw: unknown, index: number): JdRequirement | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const text = coerceText(obj["text"]);
  if (text === null) return null;

  const id = coerceId(obj["id"], index);
  const kind = coerceKind(obj["kind"]);
  const yearsRequired = coerceYears(obj["years"]);

  return yearsRequired !== undefined
    ? { id, text, kind, yearsRequired }
    : { id, text, kind };
}

/** Trimmed non-empty requirement text, or `null` when absent/blank. */
function coerceText(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.length > 0 ? text : null;
}

/** The model's `id` when usable, else a deterministic `req-N` from position. */
function coerceId(raw: unknown, index: number): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : `req-${index + 1}`;
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

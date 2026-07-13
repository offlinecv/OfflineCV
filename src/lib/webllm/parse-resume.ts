// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * LLM-backed structured resume parser (issue #241).
 *
 * Turns raw extracted text (or the richer Markdown form, preferred when
 * present) into a typed `LlmParsedResume` by prompting the in-browser
 * WebLLM engine with a JSON-mode instruction.
 *
 * ## Engine contract
 * The CALLER is responsible for:
 *   - Loading the engine via `loadEngine(modelId, onProgress)` from
 *     `web-llm.ts` before passing it here.
 *   - Bracketing the `parseResumeWithLlm` call with
 *     `acquireInference(modelId)` / `releaseInference(modelId)` to guard
 *     against concurrent eviction — see web-llm.ts §"Inference callers MUST
 *     acquire BEFORE awaiting".
 * This function never calls `loadEngine`, `acquireInference`, or
 * `releaseInference` itself — those are caller-owned so the modelId param
 * stays out of this function's signature.
 *
 * ## Pinned model
 * Uses `DEFAULT_MODEL_ID` from `./models.ts`
 * (`Qwen2.5-1.5B-Instruct-q4f16_1-MLC`). Referenced in the doc comment
 * below rather than as a runtime import — the caller owns the engine, so
 * this file does not need the constant at runtime. A future eval (issue #241
 * PR writeup) may bump the default; update the comment and models.ts together.
 *
 * ## JSON repair
 * Small models often wrap valid JSON in markdown fences or add prose. The
 * production-grade repair ladder lives in `./json-repair.ts` — shared with the
 * combined `analyze-resume.ts` pass so both callers use identical logic.
 *
 * ## No network calls
 * This function only calls `engine.chat.completions.create()`. The engine
 * itself is loaded by the caller. No fetch/XHR is issued here. The
 * "no network after model download" acceptance criterion is enforced by the
 * caller owning load and by nothing in this file touching the network.
 */

import type { WebLlmEngine } from "./types.ts";
import { tryParseJsonObject } from "./json-repair.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Structured resume extracted by the LLM provider.
 *
 * This is the raw on-device parse. It is no longer a hand-synced peer of
 * `HeuristicParsedResume`: the disagreement detector diffs two
 * `CanonicalResume` shapes, and this output is coerced into one via
 * `projectLlmDiff` (`heuristics/projections.ts`, #445) — a single field-name
 * adapter that owns the mapping, so there is nothing to keep in sync by hand.
 */
export interface LlmParsedResume {
  full_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  summary: string | null;
  skills: string[];
  experience: Array<{ company: string; title: string; description: string }>;
  education: Array<{ institution: string; degree: string }>;
}

// ---------------------------------------------------------------------------
// Safe empty shape (returned on irrecoverable parse failure)
// ---------------------------------------------------------------------------

/** The safe empty shape — exported for reuse by `analyze-resume.ts`. */
export function emptyLlmParsedResume(): LlmParsedResume {
  return {
    full_name: null,
    email: null,
    phone: null,
    location: null,
    summary: null,
    skills: [],
    experience: [],
    education: [],
  };
}

// ---------------------------------------------------------------------------
// Shape coercion
//
// Takes the parsed-but-unknown value and coerces it to LlmParsedResume.
// Every field has a safe default so callers never receive undefined/null
// arrays or wrong-typed scalars.
// ---------------------------------------------------------------------------

function coerceString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  return null;
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function coerceExperience(
  v: unknown,
): Array<{ company: string; title: string; description: string }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      company: typeof item["company"] === "string" ? item["company"].trim() : "",
      title: typeof item["title"] === "string" ? item["title"].trim() : "",
      description:
        typeof item["description"] === "string" ? item["description"].trim() : "",
    }));
}

function coerceEducation(
  v: unknown,
): Array<{ institution: string; degree: string }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      institution:
        typeof item["institution"] === "string" ? item["institution"].trim() : "",
      degree: typeof item["degree"] === "string" ? item["degree"].trim() : "",
    }));
}

/**
 * Coerce an arbitrary parsed value into a strict `LlmParsedResume`. Used both
 * here and by `analyze-resume.ts` (combined parse+critique pass) so a single
 * shape-coercion definition guards every LLM-derived parse on its way into the
 * rest of the app. Always returns a non-throwing shape — invalid input maps to
 * the safe empty shape.
 */
export function coerceLlmParsedResume(raw: unknown): LlmParsedResume {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyLlmParsedResume();
  }
  const obj = raw as Record<string, unknown>;
  return {
    full_name: coerceString(obj["full_name"]),
    email: coerceString(obj["email"]),
    phone: coerceString(obj["phone"]),
    location: coerceString(obj["location"]),
    summary: coerceString(obj["summary"]),
    skills: coerceStringArray(obj["skills"]),
    experience: coerceExperience(obj["experience"]),
    education: coerceEducation(obj["education"]),
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a resume parser. Extract structured data from the resume text provided and output ONLY a valid JSON object — no prose, no markdown fences, no explanation. The JSON must exactly match this TypeScript interface:

{
  "full_name": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "summary": string | null,
  "skills": string[],
  "experience": Array<{ "company": string, "title": string, "description": string }>,
  "education": Array<{ "institution": string, "degree": string }>
}

Rules:
- Use null for any field not found in the resume.
- Only extract what is explicitly present as its own section. Do NOT infer, synthesize, or collect a field from the prose of another section.
- skills: extract ONLY from an explicit skills section (a "Skills", "Technical Skills", "Core Competencies", "Technologies", or "Expertise" heading). If the resume has no such heading, return an empty array []. Do NOT mine skills out of experience bullets, the summary, or job descriptions — a technology named inside a work-experience bullet is NOT a skills-section entry.
- skills (when a section exists): one item per skill, strings only, no duplicates, no empty strings.
- experience: one object per role; description is a brief (1–3 sentence) summary.
- education: one object per degree/program.
- Output ONLY the JSON object. Do not add any text before or after it.`;

function buildUserPrompt(input: { rawText: string; markdown?: string }): string {
  // Prefer markdown when available — it preserves structure (headers, bullets)
  // that the LLM can use to separate sections more reliably than raw text.
  const content = input.markdown ?? input.rawText;
  return `Parse the following resume:\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a resume with an in-browser WebLLM engine.
 *
 * The engine must be pre-loaded by the caller (via `loadEngine` from
 * `web-llm.ts`). The caller must also bracket this call with
 * `acquireInference(modelId)` / `releaseInference(modelId)` to guard against
 * concurrent engine eviction.
 *
 * Pinned model: `DEFAULT_MODEL_ID` from `./models.ts`
 * (`Qwen2.5-1.5B-Instruct-q4f16_1-MLC`). The PR #241 eval writeup may
 * bump this; update the constant and this doc comment together.
 *
 * Input: provide both `rawText` and `markdown` when available — the function
 * prefers `markdown` (more structural signal). `rawText` is the fallback.
 *
 * Returns a validated `LlmParsedResume`. On irrecoverable JSON parse
 * failure the safe empty shape (all-null scalars, empty arrays) is returned —
 * this function NEVER throws to the caller.
 */
export async function parseResumeWithLlm(
  input: { rawText: string; markdown?: string },
  engine: WebLlmEngine,
): Promise<LlmParsedResume> {
  // Max tokens: enough for a dense resume JSON (~600 tok) with headroom.
  // Qwen2.5-1.5B context window is 32 768 tokens; 1 024 output tokens is
  // well within budget and keeps latency reasonable for a single-pass parse.
  const MAX_TOKENS = 1024;

  let raw = "";
  try {
    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      temperature: 0, // deterministic JSON output
      max_tokens: MAX_TOKENS,
    });
    raw = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    // Engine error (OOM, context overflow, etc.) — return safe shape, no throw.
    console.warn("[parse-resume] engine.chat.completions.create failed:", err);
    return emptyLlmParsedResume();
  }

  const parsed = tryParseJsonObject(raw);
  if (!parsed.ok) {
    console.warn("[parse-resume] JSON parse failed after repair attempts. Raw:", raw.slice(0, 200));
    return emptyLlmParsedResume();
  }

  return coerceLlmParsedResume(parsed.value);
}

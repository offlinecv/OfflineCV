// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Combined LLM analysis pass — parse + quality critique in one inference
 * (issue #262).
 *
 * Today the "What an ATS misses" (#242) and "Resume quality" (#244) tabs each
 * run their own on-device LLM inference. They share a single loaded engine, so
 * this is not a duplicate download — but it is two separate inferences, two
 * "Run" buttons, and two waits for what the user experiences as one analyze
 * action. This module collapses both into ONE `engine.chat.completions.create()`
 * call that returns a `CombinedAnalysis` with both halves populated.
 *
 * ## Schema discipline
 * `CombinedAnalysis.parse` is the EXACT `LlmParsedResume` shape used by the
 * standalone parser (`parse-resume.ts` — still used by the degenerate-case
 * escape hatch #243). `CombinedAnalysis.critique` is the EXACT `ResumeCritique`
 * shape used by the standalone critique (`critique-resume.ts` — still used by
 * the dev eval harness). This is a transport merge, not a schema redesign:
 * downstream callers (`diffParses`, `CritiquePanel`) take the same types they
 * already consume.
 *
 * ## Partial-result tolerance
 * A larger prompt and larger JSON output raise the malformed-JSON rate. To
 * avoid taking down BOTH tabs on a single bad output, the coercer reads each
 * half independently — if `critique` is missing/malformed but `parse` parsed,
 * the parse half is kept and the critique half collapses to safe empty
 * defaults (and vice versa). If the strict + repair-ladder parse fails
 * outright, both halves return their safe empty shapes — this function NEVER
 * throws to the caller.
 *
 * ## Engine contract (mirrors `parse-resume.ts`)
 * The caller owns `loadEngine` + `acquireInference` / `releaseInference`
 * bracketing. This module only issues a single `engine.chat.completions.create()`.
 *
 * ## No network calls
 * One `engine.chat.completions.create()` and nothing else. The
 * "no network after model download" invariant holds the same way it does for
 * the standalone passes.
 */

import type { WebLlmEngine } from "./types.ts";
import { tryParseJsonObject } from "./json-repair.ts";
import {
  coerceLlmParsedResume,
  emptyLlmParsedResume,
  type LlmParsedResume,
} from "./parse-resume.ts";
import {
  coerceBulletFindingObject,
  coerceMetaCritique,
  type BulletFinding,
  type ResumeCritique,
} from "./critique-resume.ts";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * The single combined LLM response, carrying both halves the two opt-in tabs
 * consume. Each half uses the existing standalone shape verbatim so the
 * downstream wiring (diff, panels) is unchanged.
 */
export interface CombinedAnalysis {
  parse: LlmParsedResume;
  critique: ResumeCritique;
}

// ── Safe empty shapes ────────────────────────────────────────────────────────

function emptyCritique(): ResumeCritique {
  return { bulletFindings: [], missingSections: [] };
}

function emptyCombined(): CombinedAnalysis {
  return { parse: emptyLlmParsedResume(), critique: emptyCritique() };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

// Schema design note (issue #262, eval Run 3):
// Run 1 + Run 2 both regressed parse accuracy on Qwen2.5-1.5B when the schema
// nested parse fields under a "parse" key — full_name (and on Run 2, skills /
// experience on different fixtures) silently dropped. The standalone parse
// prompt (`parse-resume.ts`) gets full_name right consistently; the only
// material difference was a SHORT prompt with a FLAT schema. So Run 3 follows
// that shape: every field at top level, terse rules. The coercer below
// re-assembles them into the public `CombinedAnalysis { parse, critique }`
// shape so downstream wiring is unchanged.
const SYSTEM_PROMPT = `You are a resume parser and quality judge. Given the resume text below, output ONE valid JSON object matching this TypeScript interface — no prose, no markdown fences, no explanation:

{
  "full_name": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "summary": string | null,
  "skills": string[],
  "experience": Array<{ "company": string, "title": string, "description": string }>,
  "education": Array<{ "institution": string, "degree": string }>,
  "bullet_findings": Array<{ "bullet": string, "issue": "no_quantification" | "weak_verb" | "vague" | "ok", "suggestion": string }>,
  "missing_sections": string[],
  "summary_feedback": string
}

Rules:
- Include EVERY key above. Use null for any scalar not found; use [] for any array that is empty.
- Only extract fields that are explicitly present in the resume. Do NOT infer or synthesize.
- skills: extract ONLY from an explicit Skills / Technical Skills / Core Competencies / Technologies / Expertise heading. If no such heading, return [].
- experience: one object per role; description is a brief 1–3 sentence summary.
- education: one object per degree/program.
- bullet_findings: one entry per non-blank bullet in the experience section, in document order. Use the original bullet text as "bullet". "issue" is one of:
  - "no_quantification": lacks any number, metric, or measurable outcome
  - "weak_verb": starts with was / helped / assisted / worked on / etc.
  - "vague": too generic to be meaningful
  - "ok": clear, strong action verb, AND has a metric or concrete outcome
  "suggestion" is a short improved version of the bullet; omit the key for "ok" findings.
- missing_sections: list section names absent from the resume (choose from "summary", "skills", "experience", "education"); [] if nothing is missing.
- summary_feedback: a 1-sentence note on the summary's quality. Omit the key entirely if no summary exists.

Output ONLY the JSON object.`;

function buildUserPrompt(input: { rawText: string; markdown?: string }): string {
  // Prefer markdown when available — it preserves structure (headers, bullets)
  // that the LLM can use to separate sections more reliably than raw text.
  const content = input.markdown ?? input.rawText;
  return `Analyze the following resume:\n\n${content}`;
}

// ── Coercion ─────────────────────────────────────────────────────────────────

/**
 * Coerce a parsed-but-unknown value into a `CombinedAnalysis`. The wire shape
 * is FLAT (top-level scalars + arrays) per the Run 3 prompt redesign, but the
 * public type stays `{ parse, critique }` so downstream callers (diff,
 * critique panel) are unchanged.
 *
 * Partial-result tolerance is preserved: each half is read independently from
 * the flat object. A malformed bullet_findings list does not invalidate the
 * parse fields, and a missing full_name does not invalidate the bullet
 * findings. Per-field coercion already returns safe defaults on type
 * mismatches.
 */
function coerceCombined(raw: unknown): CombinedAnalysis {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyCombined();
  }
  const obj = raw as Record<string, unknown>;

  // Parse half: `coerceLlmParsedResume` reads full_name/email/phone/... off a
  // flat object, which is exactly what the new wire shape gives us.
  const parse = coerceLlmParsedResume(obj);

  // Critique half: re-key snake_case wire names to the camelCase the existing
  // `ResumeCritique` shape uses. Building a synthetic record means the existing
  // `coerceCritiqueHalf` does not need to change — same per-entry validation,
  // same partial-list tolerance.
  const critique = coerceCritiqueHalf({
    bulletFindings: obj["bullet_findings"],
    missingSections: obj["missing_sections"],
    summaryFeedback: obj["summary_feedback"],
  });

  return { parse, critique };
}

/**
 * Coerce the critique half. Mirrors the standalone critique-resume coercion
 * but reads from a single object instead of two separate engine responses.
 * Bullet findings are validated one-by-one so a malformed entry doesn't
 * invalidate the whole list.
 */
function coerceCritiqueHalf(raw: unknown): ResumeCritique {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyCritique();
  }
  const obj = raw as Record<string, unknown>;

  const bulletFindings: BulletFinding[] = [];
  const rawFindings = obj["bulletFindings"];
  if (Array.isArray(rawFindings)) {
    for (const entry of rawFindings) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      // fallbackBullet is the empty string here — coerceBulletFinding only
      // uses it when the LLM omitted `bullet` entirely, which is an output
      // bug; rendering an empty card is preferable to crashing.
      bulletFindings.push(coerceBulletFindingObject(record, ""));
    }
  }

  const meta = coerceMetaCritique(obj);
  const result: ResumeCritique = {
    bulletFindings,
    missingSections: meta.missingSections,
  };
  if (meta.summaryFeedback !== undefined) {
    result.summaryFeedback = meta.summaryFeedback;
  }
  return result;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the combined parse + critique pass with an in-browser WebLLM engine.
 *
 * The engine must be pre-loaded by the caller (via `loadEngine` from
 * `web-llm.ts`). The caller must also bracket this call with
 * `acquireInference(modelId)` / `releaseInference(modelId)` (the #148
 * snapshot-before-await contract) to guard against concurrent engine eviction.
 *
 * Pinned model: `DEFAULT_MODEL_ID` from `./models.ts`
 * (`Qwen2.5-1.5B-Instruct-q4f16_1-MLC`). The combined prompt + larger JSON
 * output is the AC risk the #262 quality gate measures — bump the constant and
 * this doc together if the eval bakes off a larger default.
 *
 * Input: provide both `rawText` and `markdown` when available — the function
 * prefers `markdown` (more structural signal). `rawText` is the fallback.
 *
 * Returns a validated `CombinedAnalysis`. On irrecoverable JSON parse
 * failure the safe empty shape (empty parse + empty critique) is returned —
 * this function NEVER throws to the caller. On partial JSON failure, only the
 * malformed half collapses to its safe empty shape; the other half is kept.
 */
export async function analyzeResumeWithLlm(
  input: { rawText: string; markdown?: string },
  engine: WebLlmEngine,
): Promise<CombinedAnalysis> {
  // Max tokens: the parse alone needs ~600 (parse-resume.ts uses 1024). The
  // critique adds ~60 per bullet plus the meta object. The old summed budget
  // across the three separate inferences was ~2480 (1024 + 1200 + 256). 3072
  // matches that ceiling with headroom for a long resume (30+ bullets) and
  // stays well within Qwen2.5-1.5B's 32 768-token context window. Truncation
  // here kills the top-level JSON parse and collapses BOTH halves to safe
  // empty shapes — over-budgeting is cheap, under-budgeting is a hard failure.
  const MAX_TOKENS = 3072;

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
    console.warn("[analyze-resume] engine.chat.completions.create failed:", err);
    return emptyCombined();
  }

  const parsed = tryParseJsonObject(raw);
  if (!parsed.ok) {
    console.warn(
      "[analyze-resume] JSON parse failed after repair attempts. Raw:",
      raw.slice(0, 200),
    );
    return emptyCombined();
  }

  return coerceCombined(parsed.value);
}

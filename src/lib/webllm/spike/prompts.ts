// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Prototype prompts for the JD spike's two-call contract (issue #198).
 *
 * These are starting-point prompts intended for iteration via the harness —
 * they will be tuned once real model output is observed. Comments explain
 * the reasoning so tuning decisions can be tracked.
 *
 * Call 1 (extract): JD text → JSON array of JdRequirement
 * Call 2 (judge):   batch of requirements + resume projection → JSON array
 *                   of RequirementVerdict
 */

/**
 * How many requirements to include per judge batch (call 2).
 *
 * Qwen2.5-1.5B's context is 32 768 tokens. With a medium-size JD (~300
 * tokens) and a medium-size resume (~400 tokens) that still leaves room for
 * ~8 requirement objects and their verdicts before the prompt starts
 * approaching the model's practical limit. Keep at 8 for the spike; we
 * measure max prompt_tokens to inform whether this is safe.
 */
export const JUDGE_BATCH_SIZE = 8;

// ---------------------------------------------------------------------------
// Call 1 — Extract requirements from a job description
// ---------------------------------------------------------------------------

/**
 * System prompt for the extract call.
 *
 * Design notes:
 * - "JSON only, no markdown fences, no prose" addresses the most common
 *   small-model failure: wrapping JSON in ```json ... ``` or explaining
 *   itself before the array.
 * - The 4 kind values are spelled out verbatim so the model has no
 *   ambiguity about the enum.
 * - `years` is optional and integer-only; non-numeric phrases like
 *   "several years" must be omitted. This is intentional — we measure
 *   how often the model over-generates vs. under-generates this field.
 * - Requiring `id` in "req-N" form (sequential, 1-based) keeps the
 *   extract → judge id join deterministic.
 */
export const EXTRACT_SYSTEM_PROMPT = `You are a structured information extractor. Your only job is to read a job description and output a JSON array of requirements.

Output ONLY a valid JSON array — no prose, no markdown, no code fences, no explanation. The array must start with [ and end with ].

Each element in the array must be a JSON object with these exact keys:
- "id": a string like "req-1", "req-2", etc. (sequential, 1-based)
- "kind": one of exactly these four strings: "skill", "experience", "responsibility", "qualification"
- "text": a concise string capturing the requirement (keep it to one sentence)
- "years": an integer (the minimum number of years stated) — ONLY include this key when the requirement explicitly states a year count; omit it entirely otherwise

Classify each distinct requirement as:
- "skill" — a specific technology, tool, programming language, or domain capability
- "experience" — years or breadth of professional experience in a domain
- "responsibility" — a duty, deliverable, or activity the role requires
- "qualification" — a degree, certification, or formal credential

Extract every materially distinct requirement. Skip generic filler ("strong communication skills", "team player") unless the JD frames them as explicit requirements.

Output nothing except the JSON array.`;

/**
 * Build the user message for the extract call.
 * @param jdText — The raw job description text.
 */
export function buildExtractUserPrompt(jdText: string): string {
  return `Job description:\n\n${jdText}`;
}

// ---------------------------------------------------------------------------
// Call 2 — Judge requirement evidence against a resume projection
// ---------------------------------------------------------------------------

/**
 * System prompt for the judge call.
 *
 * Design notes:
 * - The model receives a BATCH of requirements to judge in one call so
 *   we minimize round-trips. JUDGE_BATCH_SIZE caps the batch.
 * - The verdict enum is 3-valued: met / partial / missing.
 *   "partial" is the nuanced case — the model should use it for adjacent
 *   skills, fewer years than required, or indirect evidence. We measure
 *   how consistently the model uses it (especially for the years-mismatch
 *   fixture).
 * - "reason" must cite the resume, not the JD. A verdict without a
 *   quote or reference is unactionable.
 * - The output array must be parallel to the input array (same ids, same
 *   order) — this simplifies the join in measure.ts.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a resume evidence evaluator. Your job is to assess whether a candidate's resume supports each of the listed job requirements.

You will receive:
1. A list of requirements (JSON array) — each has an "id", "kind", "text", and optionally "years"
2. A resume projection (plain text) — the candidate's skills, experience, and education

Output ONLY a valid JSON array — no prose, no markdown, no code fences, no explanation. The array must start with [ and end with ].

Each element must be a JSON object with these exact keys:
- "id": the requirement id from the input (copy it exactly)
- "status": one of exactly these three strings: "met", "partial", "missing"
- "reason": a single sentence citing specific evidence from the resume, or noting its absence

Status definitions:
- "met": the resume clearly demonstrates this requirement
- "partial": the resume shows some evidence but not full coverage (e.g. fewer years than required, an adjacent but not identical skill, or indirect experience)
- "missing": no relevant evidence found in the resume

For "experience" requirements with a "years" value, compare the stated years against what the resume shows. If the candidate has fewer years, use "partial" (not "missing") unless there is no relevant experience at all.

Output nothing except the JSON array. The output array must have exactly one element per input requirement, in the same order.`;

/**
 * Build the user message for a judge batch call.
 *
 * @param requirements — The batch of JdRequirement objects to judge.
 * @param resumeProjection — The candidate's flattened resume text.
 */
export function buildJudgeUserPrompt(
  requirements: ReadonlyArray<{ id: string; kind: string; text: string; years?: number }>,
  resumeProjection: string,
): string {
  const reqJson = JSON.stringify(requirements, null, 2);
  return `Requirements to evaluate:\n${reqJson}\n\nCandidate resume:\n\n${resumeProjection}`;
}

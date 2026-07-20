// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * critique-resume.ts — on-device LLM quality judge (issue #244).
 *
 * Runs an on-device WebLLM pass to judge *content quality* rather than
 * structural presence (which the heuristic scorer already covers). The LLM
 * examines each bullet and the resume as a whole, returning:
 *
 *   - Per-bullet findings: weak verb, missing quantification, vague language.
 *   - Missing section names (e.g. "summary", "skills") the LLM infers are
 *     absent from the parsed content.
 *   - Optional plain-text feedback on the summary section.
 *
 * **Design choice — runs on the heuristic parse, not the LLM parse:**
 * The critique is available to every user immediately after the heuristic
 * cascade completes, with no prerequisite LLM pass. If the #243 escape hatch
 * has already run, `ParsedCard` merges the LLM fields into `activeResult` and
 * passes that down — so the critique still sees the best available parse.
 * Running critique on whichever parse is currently "active" means one crisp,
 * well-typed input (`HeuristicParsedResume`) rather than a conditional union.
 *
 * **Prompt discipline:** the critique prompt targets a small on-device model
 * (Qwen-2.5-1.5B). It asks for newline-delimited JSON *objects*, one per
 * bullet, plus a final JSON object for section and summary findings — avoiding
 * a single large JSON array that risks truncation mid-token.
 *
 * Pure logic only — no React, no hooks, no imports from src/hooks or
 * src/components.
 */

import type { WebLlmEngine } from "./types.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface BulletFinding {
  /** The original bullet text (trimmed). */
  bullet: string;
  /** The quality category the LLM assigned. */
  issue: "no_quantification" | "weak_verb" | "vague" | "ok";
  /**
   * Optional short suggestion for `no_quantification`, `weak_verb`, or
   * `vague` issues. Absent for `ok` findings and when the model omits it.
   */
  suggestion?: string;
}

export interface ResumeCritique {
  /** One finding per non-blank bullet, in document order. */
  bulletFindings: BulletFinding[];
  /**
   * Section names the LLM believes are missing from the resume.
   * Examples: `["summary", "skills"]`. Empty when nothing is missing.
   */
  missingSections: string[];
  /**
   * Brief plain-text quality note on the summary paragraph, when one was
   * found in the parsed content. Absent when there is no summary.
   */
  summaryFeedback?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const BULLET_SYSTEM_PROMPT = `You are a resume quality judge. For each bullet point below, classify it with one JSON object per line (no wrapping array). Each object must have:
  "bullet": the original bullet text
  "issue": one of "no_quantification", "weak_verb", "vague", or "ok"
  "suggestion": a short improved version (omit for "ok")

Rules:
- "no_quantification": bullet lacks any number, metric, or measurable outcome
- "weak_verb": starts with a passive or weak verb (was, helped, assisted, worked on, etc.)
- "vague": too generic to be meaningful even if it has a verb and a number
- "ok": bullet is clear, starts with a strong action verb, and has a metric or concrete outcome
Output ONLY the JSON objects, one per line. No markdown, no explanation.`;

const META_SYSTEM_PROMPT = `You are a resume quality judge. Given the resume content summary below, respond with a single JSON object:
  "missingSections": array of section names absent from this resume (choose from: "summary", "skills", "experience", "education"); empty array if nothing is missing
  "summaryFeedback": a 1-sentence plain-text note on the summary quality (omit key if no summary exists)

Output ONLY the JSON object. No markdown, no explanation.`;

/** Collect all non-blank bullet texts from the parsed resume. */
function collectBullets(parsed: HeuristicParsedResume): string[] {
  const bullets: string[] = [];
  for (const exp of parsed.experience ?? []) {
    if (!exp.description) continue;
    for (const line of exp.description.split("\n")) {
      const t = line.replace(/^[\s•\-–*]+/, "").trim();
      if (t.length > 0) bullets.push(t);
    }
  }
  return bullets;
}

/** Parse a single JSON object from a line, returning null on failure. */
function tryParseJson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const v = JSON.parse(trimmed) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

const ISSUE_VALUES = new Set<string>([
  "no_quantification",
  "weak_verb",
  "vague",
  "ok",
]);

/**
 * Coerce one parsed JSON object into a `BulletFinding`. Exported for reuse by
 * the combined `analyze-resume.ts` pass so both call sites apply identical
 * issue-value validation and trimming.
 */
export function coerceBulletFindingObject(
  raw: Record<string, unknown>,
  fallbackBullet: string,
): BulletFinding {
  const bullet =
    typeof raw["bullet"] === "string" ? raw["bullet"].trim() : fallbackBullet;
  const rawIssue = typeof raw["issue"] === "string" ? raw["issue"] : "";
  const issue = ISSUE_VALUES.has(rawIssue)
    ? (rawIssue as BulletFinding["issue"])
    : "ok";
  const suggestion =
    typeof raw["suggestion"] === "string" && raw["suggestion"].trim()
      ? raw["suggestion"].trim()
      : undefined;
  return { bullet, issue, suggestion };
}

/**
 * Coerce one parsed JSON object into the meta half of `ResumeCritique`
 * (missingSections + optional summaryFeedback). Exported for reuse by the
 * combined `analyze-resume.ts` pass.
 */
export function coerceMetaCritique(raw: Record<string, unknown>): {
  missingSections: string[];
  summaryFeedback?: string;
} {
  const rawMissing = raw["missingSections"];
  const missingSections = Array.isArray(rawMissing)
    ? rawMissing.filter((s): s is string => typeof s === "string")
    : [];
  const summaryFeedback =
    typeof raw["summaryFeedback"] === "string" && raw["summaryFeedback"].trim()
      ? raw["summaryFeedback"].trim()
      : undefined;
  return { missingSections, summaryFeedback };
}

/**
 * Call the engine with a system+user prompt, returning the raw text content.
 * NEVER throws — on any engine failure it logs and returns an empty string so
 * the caller's parse step degrades to safe defaults. `label` names the pass in
 * the warning so failures stay diagnosable.
 */
async function callEngine(
  engine: WebLlmEngine,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  label: string,
): Promise<string> {
  try {
    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    });
    return response.choices[0]?.message?.content ?? "";
  } catch (err) {
    console.warn(`[critique-resume] ${label} pass failed:`, err);
    return "";
  }
}

/**
 * Parse the bullet-pass response into one finding per bullet, in order.
 * Empty/partial output is padded with `ok` so every bullet renders without
 * gaps.
 */
function parseBulletResponse(
  bulletRaw: string,
  bullets: string[],
): BulletFinding[] {
  // Engine returned nothing — treat all as ok; the meta section still renders.
  if (!bulletRaw.trim()) {
    return bullets.map((b) => ({ bullet: b, issue: "ok" as const }));
  }
  const findings: BulletFinding[] = [];
  // Match lines to bullets. Accept as many valid JSON lines as we get —
  // partial output is still useful.
  let bulletIdx = 0;
  for (const line of bulletRaw.split("\n")) {
    if (bulletIdx >= bullets.length) break;
    const obj = tryParseJson(line);
    if (obj === null) continue;
    findings.push(coerceBulletFindingObject(obj, bullets[bulletIdx]!));
    bulletIdx++;
  }
  // If the model returned fewer findings than bullets (truncation), pad with
  // "ok" so the UI can still show all bullets without gaps.
  for (let i = findings.length; i < bullets.length; i++) {
    findings.push({ bullet: bullets[i]!, issue: "ok" });
  }
  return findings;
}

/** Pass 1: per-bullet critique. Returns `[]` when there are no bullets. */
async function runBulletPass(
  bullets: string[],
  engine: WebLlmEngine,
): Promise<BulletFinding[]> {
  if (bullets.length === 0) return [];
  const userPrompt = bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");
  // Max tokens: ~60 per bullet (issue + suggestion) + headroom.
  const maxTokens = Math.min(64 * bullets.length + 128, 1200);
  const raw = await callEngine(
    engine,
    BULLET_SYSTEM_PROMPT,
    `Bullets:\n${userPrompt}`,
    maxTokens,
    "bullet",
  );
  return parseBulletResponse(raw, bullets);
}

/** Build the compact content summary fed to the meta pass. */
function buildMetaContent(
  parsed: HeuristicParsedResume,
  bulletCount: number,
): string {
  const hasExperience = (parsed.experience ?? []).length > 0;
  const hasEducation = (parsed.education ?? []).length > 0;
  const hasSkills = (parsed.skills ?? []).length > 0;
  const hasSummary =
    typeof parsed.summary === "string" && parsed.summary.trim().length > 0;
  const summaryText = hasSummary ? (parsed.summary as string) : "";

  return [
    `summary: ${hasSummary ? `"${summaryText.slice(0, 300)}"` : "absent"}`,
    `skills: ${hasSkills ? `${(parsed.skills ?? []).length} listed` : "absent"}`,
    `experience: ${hasExperience ? `${(parsed.experience ?? []).length} role(s)` : "absent"}`,
    `education: ${hasEducation ? `${(parsed.education ?? []).length} entry` : "absent"}`,
    `bullet count: ${bulletCount}`,
  ].join("\n");
}

/** Extract the first `{…}` JSON block from the meta response and coerce it. */
function parseMetaResponse(metaRaw: string): {
  missingSections: string[];
  summaryFeedback?: string;
} {
  if (!metaRaw.trim()) return { missingSections: [] };
  const firstBrace = metaRaw.indexOf("{");
  const lastBrace = metaRaw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return { missingSections: [] };
  }
  const obj = tryParseJson(metaRaw.slice(firstBrace, lastBrace + 1));
  if (obj === null) return { missingSections: [] };
  return coerceMetaCritique(obj);
}

/** Pass 2: meta critique (missing sections + summary feedback). */
async function runMetaPass(
  parsed: HeuristicParsedResume,
  bulletCount: number,
  engine: WebLlmEngine,
): Promise<{ missingSections: string[]; summaryFeedback?: string }> {
  const metaContent = buildMetaContent(parsed, bulletCount);
  const raw = await callEngine(
    engine,
    META_SYSTEM_PROMPT,
    `Resume sections:\n${metaContent}`,
    256,
    "meta",
  );
  return parseMetaResponse(raw);
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run an on-device LLM critique of the resume.
 *
 * Accepts the heuristic (or LLM-overridden) parsed resume and the already-
 * loaded engine. Returns a `ResumeCritique` with per-bullet findings and
 * missing-section flags. This function NEVER throws — on any engine or parse
 * failure it returns a safe empty shape so the UI degrades gracefully.
 *
 * Two passes:
 *   1. Bullet critique — one JSON object per line.
 *   2. Meta critique — one JSON object covering missing sections + summary.
 */
export async function critiqueResumeWithLlm(
  parsed: HeuristicParsedResume,
  engine: WebLlmEngine,
): Promise<ResumeCritique> {
  const bullets = collectBullets(parsed);
  const bulletFindings = await runBulletPass(bullets, engine);
  const { missingSections, summaryFeedback } = await runMetaPass(
    parsed,
    bullets.length,
    engine,
  );
  return { bulletFindings, missingSections, summaryFeedback };
}

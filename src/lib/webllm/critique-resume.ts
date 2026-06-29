// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

function coerceBulletFinding(
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

function coerceMeta(raw: Record<string, unknown>): {
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

  // ── Pass 1: Per-bullet critique ─────────────────────────────────────────────
  let bulletFindings: BulletFinding[] = [];
  if (bullets.length > 0) {
    const bulletUserPrompt = bullets
      .map((b, i) => `${i + 1}. ${b}`)
      .join("\n");
    // Max tokens: ~60 per bullet (issue + suggestion) + headroom.
    const bulletMaxTokens = Math.min(64 * bullets.length + 128, 1200);

    let bulletRaw = "";
    try {
      const response = await engine.chat.completions.create({
        messages: [
          { role: "system", content: BULLET_SYSTEM_PROMPT },
          { role: "user", content: `Bullets:\n${bulletUserPrompt}` },
        ],
        temperature: 0,
        max_tokens: bulletMaxTokens,
      });
      bulletRaw = response.choices[0]?.message?.content ?? "";
    } catch (err) {
      console.warn("[critique-resume] bullet pass failed:", err);
    }

    if (bulletRaw.trim()) {
      const lines = bulletRaw.split("\n");
      // Try to match lines to bullets. Accept as many valid JSON lines as we
      // get — partial output is still useful.
      let bulletIdx = 0;
      for (const line of lines) {
        if (bulletIdx >= bullets.length) break;
        const obj = tryParseJson(line);
        if (obj === null) continue;
        bulletFindings.push(coerceBulletFinding(obj, bullets[bulletIdx]!));
        bulletIdx++;
      }
      // If the model returned fewer findings than bullets (truncation), pad
      // with "ok" so the UI can still show all bullets without gaps.
      for (let i = bulletFindings.length; i < bullets.length; i++) {
        bulletFindings.push({ bullet: bullets[i]!, issue: "ok" });
      }
    } else {
      // Engine returned nothing — treat all as ok, critique still renders
      // the meta section.
      bulletFindings = bullets.map((b) => ({ bullet: b, issue: "ok" as const }));
    }
  }

  // ── Pass 2: Meta critique (missing sections + summary) ──────────────────────
  let missingSections: string[] = [];
  let summaryFeedback: string | undefined;

  // Build a compact content summary for the meta pass.
  const hasExperience = (parsed.experience ?? []).length > 0;
  const hasEducation = (parsed.education ?? []).length > 0;
  const hasSkills = (parsed.skills ?? []).length > 0;
  const hasSummary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0;
  const summaryText = hasSummary ? (parsed.summary as string) : "";

  const metaContent = [
    `summary: ${hasSummary ? `"${summaryText.slice(0, 300)}"` : "absent"}`,
    `skills: ${hasSkills ? `${(parsed.skills ?? []).length} listed` : "absent"}`,
    `experience: ${hasExperience ? `${(parsed.experience ?? []).length} role(s)` : "absent"}`,
    `education: ${hasEducation ? `${(parsed.education ?? []).length} entry` : "absent"}`,
    `bullet count: ${bullets.length}`,
  ].join("\n");

  let metaRaw = "";
  try {
    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: META_SYSTEM_PROMPT },
        { role: "user", content: `Resume sections:\n${metaContent}` },
      ],
      temperature: 0,
      max_tokens: 256,
    });
    metaRaw = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    console.warn("[critique-resume] meta pass failed:", err);
  }

  if (metaRaw.trim()) {
    // The meta response is a single JSON object — find the first `{…}` block.
    const firstBrace = metaRaw.indexOf("{");
    const lastBrace = metaRaw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const obj = tryParseJson(metaRaw.slice(firstBrace, lastBrace + 1));
      if (obj !== null) {
        const coerced = coerceMeta(obj);
        missingSections = coerced.missingSections;
        summaryFeedback = coerced.summaryFeedback;
      }
    }
  }

  return { bulletFindings, missingSections, summaryFeedback };
}

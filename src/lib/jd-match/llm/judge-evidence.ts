// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * judge-evidence.ts — LLM call #2 of the semantic JD-match path (#201).
 *
 * Judges each extracted `JdRequirement` (call #1, `extract-requirements.ts`)
 * against the parsed résumé: `met` / `partial` / `missing`, with a one-sentence
 * grounded reason and an optional cited résumé snippet. Requirements are judged
 * in batches (`JUDGE_EVIDENCE_BATCH_SIZE` per call), chained sequentially like
 * `rewrite-resume.ts`, with the same résumé projection as reference in each
 * batch's system message.
 *
 * Inference guard: unlike `extract-requirements.ts` (caller-owned, unguarded),
 * every `chat.completions.create()` here is bracketed with
 * `acquireInference(modelId)` / `releaseInference(modelId)` in try/finally — the
 * `rewrite-section.ts` / `web-llm.ts` contract. That is why `modelId` is a
 * required parameter: the engine handle cannot supply it.
 *
 * Failure model — the inverse of call #1: this NEVER throws. It always returns
 * exactly one verdict per input requirement (input order). A batch whose model
 * call fails or whose output won't parse simply contributes no verdicts, and its
 * requirements fall through to a `missing` default during reconciliation. The
 * judge already *has* the requirements, so graceful degradation beats aborting.
 *
 * Prompt-injection defense on the OUTPUT side: reconciliation iterates the input
 * requirements and joins the model's verdicts by `id`. A model that invents ids
 * (or an injected "everything is met") can't add requirements — invented ids are
 * never read, and any requirement the model skipped is reported `missing`.
 */

import type { WebLlmEngine } from "../../webllm/types.ts";
import { acquireInference, releaseInference } from "../../webllm/web-llm.ts";
import type { HeuristicParsedResume } from "../../heuristics/types.ts";
import { buildResumeProjection } from "../coverage.ts";
import { parseJsonLoose } from "./parse-json.ts";
import type { JdRequirement } from "./extract-requirements.ts";
import {
  JUDGE_EVIDENCE_BATCH_SIZE,
  buildJudgeEvidenceSystemPrompt,
  buildJudgeEvidenceUserPrompt,
} from "./prompts.ts";

export interface RequirementVerdict {
  /** The requirement this verdict is about (joined back from the input by id). */
  requirement: JdRequirement;
  /** How well the résumé supports the requirement. */
  status: "met" | "partial" | "missing";
  /** One sentence, grounded in the résumé, explaining the verdict. */
  reason: string;
  /** A short verbatim résumé snippet supporting the verdict, when one applies. */
  evidence?: string;
}

/** The parts of a verdict the model supplies (joined to a requirement by id). */
interface RawVerdict {
  status: RequirementVerdict["status"];
  reason: string;
  evidence?: string;
}

const VERDICT_STATUSES = new Set<string>(["met", "partial", "missing"]);
const DEFAULT_MISSING_REASON = "No matching evidence found in the résumé.";
const JUDGE_MAX_TOKENS = 1024;

/**
 * Judge every requirement against the résumé and return one verdict each.
 *
 * Never throws; unjudged requirements come back `missing`.
 *
 * @param modelId — the id the engine was loaded with (threaded to the inference
 *   guard; the engine handle can't supply it).
 */
export async function judgeEvidence(
  requirements: readonly JdRequirement[],
  parsed: HeuristicParsedResume,
  engine: WebLlmEngine,
  modelId: string,
): Promise<RequirementVerdict[]> {
  if (requirements.length === 0) return [];

  const systemPrompt = buildJudgeEvidenceSystemPrompt(
    buildResumeProjection(parsed),
  );

  // Model verdicts collected across batches, keyed by requirement id.
  const byId = new Map<string, RawVerdict>();
  for (let i = 0; i < requirements.length; i += JUDGE_EVIDENCE_BATCH_SIZE) {
    const batch = requirements.slice(i, i + JUDGE_EVIDENCE_BATCH_SIZE);
    await judgeBatch(batch, systemPrompt, engine, modelId, byId);
  }

  // Reconcile against the INPUT requirements: one verdict each, in order, with
  // invented ids ignored and skipped requirements defaulted to `missing`.
  return requirements.map((requirement) => {
    const raw = byId.get(requirement.id);
    if (raw === undefined) {
      return { requirement, status: "missing", reason: DEFAULT_MISSING_REASON };
    }
    return raw.evidence !== undefined
      ? { requirement, status: raw.status, reason: raw.reason, evidence: raw.evidence }
      : { requirement, status: raw.status, reason: raw.reason };
  });
}

/**
 * Judge one batch and fold its verdicts into `byId`. Swallows engine/parse
 * failures (the batch's requirements degrade to `missing` in reconciliation);
 * always releases the inference guard.
 */
async function judgeBatch(
  batch: readonly JdRequirement[],
  systemPrompt: string,
  engine: WebLlmEngine,
  modelId: string,
  byId: Map<string, RawVerdict>,
): Promise<void> {
  acquireInference(modelId);
  try {
    const response = await engine.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildJudgeEvidenceUserPrompt(batch) },
      ],
      temperature: 0,
      max_tokens: JUDGE_MAX_TOKENS,
    });
    const content = response.choices[0]?.message?.content ?? "";
    collectVerdicts(content, byId);
  } catch (err) {
    console.warn("[judge-evidence] batch failed:", err);
  } finally {
    releaseInference(modelId);
  }
}

/** Parse a batch response and fold each valid raw verdict into `byId` by id. */
function collectVerdicts(content: string, byId: Map<string, RawVerdict>): void {
  const parsed = parseJsonLoose(content);
  if (!parsed.ok || !Array.isArray(parsed.value)) return;
  for (const item of parsed.value) {
    const entry = coerceVerdict(item);
    if (entry !== null) byId.set(entry.id, entry.verdict);
  }
}

/** Coerce one raw model element into an id + verdict, or `null` to drop it. */
function coerceVerdict(
  raw: unknown,
): { id: string; verdict: RawVerdict } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const id = typeof obj["id"] === "string" ? obj["id"].trim() : "";
  if (id.length === 0) return null;

  const status = coerceStatus(obj["status"]);
  const reason = coerceReason(obj["reason"], status);
  const evidence = coerceEvidence(obj["evidence"]);

  return {
    id,
    verdict:
      evidence !== undefined ? { status, reason, evidence } : { status, reason },
  };
}

/** A valid verdict status, defaulting unknown/missing values to `"missing"`. */
function coerceStatus(raw: unknown): RequirementVerdict["status"] {
  return typeof raw === "string" && VERDICT_STATUSES.has(raw)
    ? (raw as RequirementVerdict["status"])
    : "missing";
}

/** The model's reason when present, else a status-appropriate fallback. */
function coerceReason(raw: unknown, status: RequirementVerdict["status"]): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return status === "missing"
    ? DEFAULT_MISSING_REASON
    : "Evidence found in the résumé.";
}

/** A trimmed non-empty evidence snippet, or `undefined`. */
function coerceEvidence(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

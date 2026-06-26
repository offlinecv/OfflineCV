// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Spike-local types for the JD requirement-extraction + evidence-judging
 * experiment (issue #198). NOT shared with production code.
 *
 * The goal: validate that Qwen2.5-1.5B can reliably (a) extract structured
 * requirements from a job description and (b) judge per-requirement
 * evidence from a resume projection — measuring JSON reliability and
 * token budget headroom before committing to a production design.
 */

// ---------------------------------------------------------------------------
// Domain types — the two-call contract
// ---------------------------------------------------------------------------

/**
 * A single requirement extracted from a job description (call 1 output).
 *
 * `id` must be stable across extract → judge (the judge receives the same
 * id list and returns verdicts keyed by it). Kebab-case, sequential.
 */
export interface JdRequirement {
  /** Stable kebab-case identifier, e.g. "req-1". */
  id: string;
  /**
   * Semantic category of the requirement.
   * - `skill`          — a specific technology, language, or tool
   * - `experience`     — years or domain of professional experience
   * - `responsibility` — a duty or deliverable listed in the JD
   * - `qualification`  — a degree, certification, or other credential
   */
  kind: "skill" | "experience" | "responsibility" | "qualification";
  /** Verbatim or lightly cleaned requirement text from the JD. */
  text: string;
  /**
   * Integer years extracted from the requirement, if stated.
   * e.g. "3+ years of Python" → 3. `undefined` when no year count is given.
   */
  years?: number;
}

/**
 * The model's verdict on one requirement vs. the resume (call 2 output).
 *
 * `id` must match a `JdRequirement.id` from call 1 so the caller can
 * zip verdicts back to requirements.
 */
export interface RequirementVerdict {
  /** Must match the corresponding `JdRequirement.id`. */
  id: string;
  /**
   * - `met`     — clear evidence in the resume projection
   * - `partial` — some evidence but not conclusive (e.g. fewer years, adjacent skill)
   * - `missing` — no relevant evidence found
   */
  status: "met" | "partial" | "missing";
  /** One-sentence explanation of the verdict, citing resume evidence or absence. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Measurement types — per-call stats captured by measure.ts
// ---------------------------------------------------------------------------

/**
 * Timing and reliability stats for a single model call (extract or judge).
 */
export interface CallMeasurement {
  /** Prompt tokens reported in `response.usage.prompt_tokens` (0 if unavailable). */
  promptTokens: number;
  /** Completion tokens reported in `response.usage.completion_tokens` (0 if unavailable). */
  completionTokens: number;
  /** Wall-clock time for the call in milliseconds. */
  latencyMs: number;
  /**
   * How the JSON was parsed:
   * - `strict`  — `JSON.parse` succeeded on the raw response
   * - `repaired` — raw parse failed; fence-strip / bracket-extraction succeeded
   * - `failed`  — both attempts failed; payload is unusable
   */
  parseMode: "strict" | "repaired" | "failed";
}

/** Measurements from one full spike run (extract + N judge batches) for one fixture × repeat. */
export interface RunMeasurements {
  /** The extract call measurement (call 1). */
  extractCall: CallMeasurement;
  /** One measurement per judge-batch call (call 2 × batches). */
  judgeCalls: CallMeasurement[];
}

/** Per-fixture stats aggregated over R repeats. */
export interface FixtureStats {
  /** Fixture id (matches `SpikeFixture.id`). */
  fixtureId: string;
  /** Number of repeats actually run. */
  repeats: number;
  /** Rate of extract-call JSON parse failures over repeats (0..1). */
  extractFailureRate: number;
  /** Rate of any judge-batch JSON parse failure over repeats (0..1). */
  judgeFailureRate: number;
  /** Max prompt_tokens seen across all extract calls in this fixture's repeats. */
  extractMaxPromptTokens: number;
  /** Max prompt_tokens seen across all judge calls in this fixture's repeats. */
  judgeMaxPromptTokens: number;
  /** Cold-run extract latency (first repeat, ms). */
  extractColdLatencyMs: number;
  /** Warm-run extract latency (mean of repeats 2+, ms; null when repeats < 2). */
  extractWarmLatencyMs: number | null;
  /** Mean judge-call latency across all repeats × batches (ms). */
  judgeWarmLatencyMs: number | null;
}

/** Top-level report produced by measure.ts after running all fixtures. */
export interface SpikeReport {
  /** ISO-8601 timestamp the spike run started. */
  startedAt: string;
  /** Model id used for this run. */
  modelId: string;
  /** Number of repeats per fixture. */
  repeatsPerFixture: number;
  /** Per-fixture breakdown. */
  fixtures: FixtureStats[];
  /** Overall extract JSON-failure rate across all fixtures × repeats. */
  overallExtractFailureRate: number;
  /** Overall judge JSON-failure rate across all fixtures × repeats × batches. */
  overallJudgeFailureRate: number;
  /**
   * Max prompt_tokens seen in any extract call (token-budget headroom signal).
   * Compare against the model's context window (Qwen2.5-1.5B: 32 768 tokens).
   */
  overallMaxExtractPromptTokens: number;
  /**
   * Max prompt_tokens seen in any judge batch call.
   */
  overallMaxJudgePromptTokens: number;
}

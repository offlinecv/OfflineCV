// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared types for the rewrite-quality eval harness (issue #65).
 *
 * The harness is a Node/Vitest-runnable scoring pipeline that grades the
 * output of a section-rewrite against a deterministic rubric. The model
 * inference leg is browser-only (WebGPU); the scoring leg is
 * model-agnostic and ships with full unit coverage in CI.
 *
 * The shapes here are the seam between those two legs: a `RewriteFn`
 * implementation (real engine in the browser, stub in CI/tests) produces
 * `RawRewriteOutput` records, and the runner feeds them into `scoreRubric`.
 */

/**
 * Fixture kind drives which rubric criteria are applicable. `redundant`
 * fixtures expect dedup; `numeric` fixtures expect strict number
 * preservation; `strong` fixtures expect minimal change. The kind is the
 * fixture's claim about itself, not a measured property — it gates rule
 * application, not pass/fail.
 */
export type FixtureKind = "weak" | "strong" | "numeric" | "redundant";

/**
 * One résumé-section fixture: a tagged set of input bullets.
 *
 * `description` is for humans reading the committed report — it explains
 * what the fixture is testing. `bullets` are the input to the rewrite; the
 * runner does NOT mutate or filter them.
 */
export interface RewriteFixture {
  /** Stable identifier used in report tables. Kebab-case. */
  id: string;
  /** Which rubric criteria apply (see `FixtureKind`). */
  kind: FixtureKind;
  /** Human-readable description for the committed report. */
  description: string;
  /** The input bullets passed to the rewrite. */
  bullets: readonly string[];
}

/**
 * Per-criterion pass/fail booleans + diagnostic detail. Each field is a
 * deterministic, model-free check; no field requires a judge model. The
 * optional `judge` slot is the gated coherence score from #65's optional
 * AC — null when the flag is off (the default).
 */
export interface RubricResult {
  /** Every numeric token from input survived; none invented. */
  numbersPreserved: boolean;
  /** Every output bullet is a single line (no embedded `\n`). */
  oneLinePerBullet: boolean;
  /** Every output bullet's first token is in the curated verb list. */
  actionVerbLead: boolean;
  /** Every output bullet length lies inside the sanity band. */
  lengthSanity: boolean;
  /** Output contains none of the prompt-scaffolding echo phrases. */
  noPreambleLeak: boolean;
  /**
   * For `redundant` fixtures: output bullet count < input bullet count.
   * `null` for non-redundant fixtures (the criterion does not apply).
   */
  dedupEffective: boolean | null;
  /**
   * Flag-gated LLM-judge coherence score, 0..1. `null` when the judge is
   * off (default in CI and the committed scripts). Never required for any
   * acceptance gate — the harness reports it advisory-only.
   */
  judgeCoherence: number | null;
  /** Per-bullet diagnostic detail surfaced in the report. */
  perBullet: PerBulletDiagnostic[];
  /**
   * Numbers that the model dropped from input (multiset diff). Empty when
   * numbersPreserved is true.
   */
  droppedNumbers: string[];
  /**
   * Numbers that appeared in output but not input (multiset diff). Empty
   * when numbersPreserved is true.
   */
  addedNumbers: string[];
}

export interface PerBulletDiagnostic {
  /** Index in the output (0-based). */
  index: number;
  /** The bullet text, post-cleanup. */
  text: string;
  /** First-token check (one of the rubric criteria). */
  startsWithActionVerb: boolean;
  /** Length-sanity check (one of the rubric criteria). */
  lengthOk: boolean;
  /** Single-line check (the input line had no embedded `\n`). */
  oneLine: boolean;
}

/**
 * Raw rewrite output produced by a `RewriteFn`. The runner feeds this
 * straight into `scoreRubric` — the rubric does NOT call the model.
 */
export interface RawRewriteOutput {
  /** Rewritten bullets, post the shared `cleanRewriteLine` cleanup. */
  bullets: readonly string[];
  /**
   * Raw model output before line-splitting, kept so the rubric can spot
   * preamble leakage across the whole response (not just per-bullet).
   */
  raw: string;
}

/**
 * The pluggable inference seam. The Node scoring tests pass a stub that
 * returns canned outputs; the browser entry passes a real WebLLM-backed
 * implementation. Neither leg owns the rubric — they only produce the
 * output the rubric consumes.
 */
export type RewriteFn = (input: {
  modelId: string;
  variantId: string;
  fixture: RewriteFixture;
}) => Promise<RawRewriteOutput>;

/** A prompt variant in the compare matrix. */
export interface PromptVariant {
  /** Stable identifier used in report tables. Kebab-case. */
  id: string;
  /** Human-readable label for the committed report. */
  label: string;
  /** System prompt the model is asked to follow. */
  systemPrompt: string;
}

/** One row in the (model × variant × fixture) matrix. */
export interface RunRecord {
  modelId: string;
  variantId: string;
  fixtureId: string;
  fixtureKind: FixtureKind;
  inputBulletCount: number;
  outputBulletCount: number;
  rubric: RubricResult;
  /** Wall-clock ms spent inside the `RewriteFn` (browser-leg only). */
  rewriteDurationMs: number | null;
  /**
   * Set when the `RewriteFn` threw or returned an unparseable response.
   * The runner records the error and moves on — the row scores 0 across
   * all criteria so it shows up in the report instead of being silently
   * skipped.
   */
  error: string | null;
}

/** Aggregate report shape that report.ts formats. */
export interface EvalReport {
  /** ISO-8601 timestamp the run started. */
  startedAt: string;
  /** OfflineCV commit SHA the eval ran against, if resolvable. */
  appVersion: string | null;
  /** Models compared in this run. */
  modelIds: readonly string[];
  /** Prompt variants compared in this run. */
  variantIds: readonly string[];
  /** Fixtures evaluated. */
  fixtureIds: readonly string[];
  /** Whether the judge flag was set when this run executed. */
  judgeEnabled: boolean;
  /** Per-row records. */
  records: readonly RunRecord[];
  /** Per-(model, variant) aggregate over fixtures. */
  aggregates: readonly AggregateRow[];
}

export interface AggregateRow {
  modelId: string;
  variantId: string;
  /** Number of fixtures that produced a usable rubric (i.e. not errored). */
  scoredFixtures: number;
  /** 0..1 per-criterion pass rate across scored fixtures. */
  numbersPreservedRate: number;
  oneLineRate: number;
  actionVerbRate: number;
  lengthSanityRate: number;
  noPreambleLeakRate: number;
  /** 0..1 across `redundant` fixtures only; `null` if none in the set. */
  dedupEffectiveRate: number | null;
  /** Mean judge score across scored fixtures; `null` when judge is off. */
  judgeMean: number | null;
  /** Equal-weight mean of the deterministic rates (judge excluded). */
  aggregateScore: number;
}

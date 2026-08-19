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
  /**
   * Steering-adherence probe (#608 half 2). When present, the runner passes
   * `instruction` to the rewrite as `RewriteSteering.userInstructions` and the
   * rubric scores whether the output obeyed it, via `check`.
   *
   * Absent on every pre-#608 fixture, which keeps their prompts and their
   * scores exactly as they were — `steeringAdherence` is `null` for them and
   * the aggregate ignores it.
   */
  steering?: FixtureSteering;
}

/** The instruction a fixture steers with, plus how to verify compliance. */
export interface FixtureSteering {
  /** Passed verbatim as the user's rewrite instruction. */
  instruction: string;
  /** Deterministic verification of `instruction` — see `adherence.ts`. */
  check: AdherenceCheck;
}

/**
 * A mechanically-checkable instruction.
 *
 * Every variant must be verifiable by inspecting the output string alone, with
 * no judge model — that is the constraint that makes an adherence number worth
 * arguing from (see `adherence.ts`). Adding a variant means adding a case to
 * `scoreAdherence` and `describeCheck`; both switch exhaustively, so TypeScript
 * flags a half-done addition.
 */
export type AdherenceCheck =
  | { kind: "forbidden-word"; word: string }
  | { kind: "max-words"; limit: number }
  | { kind: "distinct-verbs" };

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
   * For fixtures carrying a `steering` probe (#608): did the output obey the
   * instruction? `null` for fixtures without one (the criterion does not
   * apply), which is every pre-#608 fixture.
   */
  steeringAdherence: boolean | null;
  /**
   * Flag-gated LLM-judge coherence score, 0..1. `null` when the judge is
   * off (default in CI and the committed scripts). Never required for any
   * acceptance gate — the harness reports it advisory-only.
   */
  judgeCoherence: number | null;
  /** Per-bullet diagnostic detail surfaced in the report. */
  perBullet: PerBulletDiagnostic[];
  /**
   * Numbers that the model dropped from input (set diff). Empty when
   * numbersPreserved is true.
   */
  droppedNumbers: string[];
  /**
   * Numbers that appeared in output but not input (set diff). Empty
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
  /**
   * The #778 reject gate fired: the model dropped or invented a number, so
   * `bullets` is the fixture's input rather than the model's rewrite. Optional
   * because the Node test stubs produce output directly and never run the
   * gate; absent is read as `false`.
   *
   * Diagnostic only — it is deliberately NOT a rubric criterion. A revert is a
   * *success* of the guardrail and a *failure* of the model, and folding those
   * into one pass/fail would make the composite score unreadable.
   */
  reverted?: boolean;
  /**
   * The numeric tokens that triggered the revert — dropped ones first, then
   * invented ones, undifferentiated because the cell's verdict is the same
   * either way. Recorded because the rubric re-derives its diff from
   * `bullets`, which after a revert equals the input — so without this the
   * committed report would show a clean cell with no trace of what the model
   * actually lost or made up.
   */
  revertedNumbers?: readonly string[];
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
  /**
   * The #778 gate rejected this cell's rewrite and the input bullets were
   * scored instead. `numbersPreserved` on a reverted row is true by
   * construction, so this is the field that keeps the rate honest — read the
   * two together, never `Numbers` alone.
   */
  reverted: boolean;
  /**
   * The numeric tokens that triggered the revert — dropped then invented,
   * undifferentiated; empty when the gate did not fire.
   */
  revertedNumbers: string[];
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
  /**
   * 0..1 per-criterion pass rate across scored fixtures.
   *
   * Since #778 this is a rate over the DELIVERED output, so a reverted cell
   * counts as preserved. Read it with `revertedRate`, which is the only column
   * that separates the two ways to score 100% here: 100%/0% is a model that
   * kept every number, 100%/60% is the gate carrying it. Now that the gate
   * covers invention as well as dropping, every cell that produced any output
   * at all scores true — the rate is ~100% BY CONSTRUCTION, and reading it
   * without `revertedRate` says nothing about the model.
   *
   * A diagnostic, NOT a criterion — excluded from `aggregateScore` for exactly
   * that reason. A term that is ~1.0 for every model adds no signal to the
   * composite and dilutes the criteria that do discriminate.
   */
  numbersPreservedRate: number;
  /**
   * 0..1 share of scored fixtures whose rewrite the #778 gate rejected.
   * A diagnostic, NOT a criterion — deliberately excluded from
   * `aggregateScore`, since a revert is the guardrail working and scoring it
   * as either a pass or a fail would misstate the run.
   */
  revertedRate: number;
  oneLineRate: number;
  actionVerbRate: number;
  lengthSanityRate: number;
  noPreambleLeakRate: number;
  /** 0..1 across `redundant` fixtures only; `null` if none in the set. */
  dedupEffectiveRate: number | null;
  /** 0..1 across steering-probe fixtures only; `null` if none in the set.
   *  The #608 half-2 number. */
  steeringAdherenceRate: number | null;
  /** Mean judge score across scored fixtures; `null` when judge is off. */
  judgeMean: number | null;
  /** Equal-weight mean of the deterministic rates (judge excluded). */
  aggregateScore: number;
}

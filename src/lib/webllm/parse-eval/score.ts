// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Pure, model-free scorer for the parse-resume eval harness (issue #241).
 *
 * Given an `LlmParsedResume` and the fixture's expected ground truth, computes
 * field-level accuracy across four dimensions:
 *
 *   1. **Scalar** — exact-match (after normalization) for full_name, email,
 *      phone, location, summary. Score = fraction of non-null expected fields
 *      that exactly match the actual value.
 *
 *   2. **Skills** — Jaccard set overlap (intersection ÷ union) after
 *      normalizing each skill to lowercase-trimmed form. Returns 1.0 when
 *      both sets are empty.
 *
 *   3. **Experience** — first checks array length match, then per-entry
 *      key-field match (company + title normalized). Score = fraction of
 *      expected entries whose company+title appear in the actual result.
 *
 *   4. **Education** — same as experience but for institution + degree.
 *
 * Plus a `validJson` boolean: `true` when the actual result is not the safe
 * empty shape (i.e., the LLM produced parseable JSON with at least one
 * non-null/non-empty field).
 *
 * All scorers are pure over their inputs — no model, no engine, no side
 * effects. Deterministic and unit-testable offline.
 */

import type { LlmParsedResume } from "../parse-resume.ts";

// ---------------------------------------------------------------------------
// Per-fixture score record
// ---------------------------------------------------------------------------

/**
 * Per-field verdict for a single scalar field on one fixture.
 *
 * Capturing this (not just the rolled-up `scalarAccuracy`) is what lets a run
 * name *which* scalar missed rather than reporting a bare "80%". Safe to keep
 * the literal `expected`/`actual` strings here: the eval fixtures are synthetic
 * personas only (see fixtures.ts / CLAUDE.md PII policy), so no real PII can
 * flow into a report.
 *
 * - `match`    — actual equals expected (case-insensitive, trimmed).
 * - `mismatch` — actual is non-null but differs from expected.
 * - `missing`  — expected is non-null but the model returned null.
 * - `skipped`  — expected is null (field not applicable); not counted in accuracy.
 */
export type ScalarFieldStatus = "match" | "mismatch" | "missing" | "skipped";

export interface ScalarFieldResult {
  field: "full_name" | "email" | "phone" | "location" | "summary";
  status: ScalarFieldStatus;
  expected: string | null;
  actual: string | null;
}

export interface FixtureScore {
  fixtureId: string;
  fixtureLabel: string;
  /** True when the model produced parseable JSON with at least one field set. */
  validJson: boolean;
  /** Fraction of non-null expected scalar fields that exactly matched (0–1). */
  scalarAccuracy: number;
  /** Per-field scalar verdicts — names exactly which scalar matched/missed. */
  scalarBreakdown: ScalarFieldResult[];
  /** Jaccard overlap of the skills sets (0–1). */
  skillsAccuracy: number;
  /**
   * Fraction of expected experience entries whose company+title appear in the
   * actual result, regardless of order (0–1).
   */
  experienceAccuracy: number;
  /**
   * Fraction of expected education entries whose institution+degree appear in
   * the actual result, regardless of order (0–1).
   */
  educationAccuracy: number;
}

// ---------------------------------------------------------------------------
// Aggregate score record
// ---------------------------------------------------------------------------

export interface ParseEvalReport {
  modelId: string;
  startedAt: string;
  fixtures: FixtureScore[];
  /** Mean validJson rate across fixtures (0–1). */
  validJsonRate: number;
  /** Mean scalar accuracy across fixtures (0–1). */
  meanScalarAccuracy: number;
  /** Mean skills accuracy across fixtures (0–1). */
  meanSkillsAccuracy: number;
  /** Mean experience accuracy across fixtures (0–1). */
  meanExperienceAccuracy: number;
  /** Mean education accuracy across fixtures (0–1). */
  meanEducationAccuracy: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/** True when the resume has at least one non-null/non-empty field. */
export function isValidJsonResult(result: LlmParsedResume): boolean {
  return (
    result.full_name !== null ||
    result.email !== null ||
    result.phone !== null ||
    result.location !== null ||
    result.summary !== null ||
    result.skills.length > 0 ||
    result.experience.length > 0 ||
    result.education.length > 0
  );
}

// ---------------------------------------------------------------------------
// Scalar scoring
// ---------------------------------------------------------------------------

const SCALAR_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "summary",
] as const;

type ScalarField = (typeof SCALAR_FIELDS)[number];

function scoreScalars(
  actual: LlmParsedResume,
  expected: LlmParsedResume,
): { accuracy: number; breakdown: ScalarFieldResult[] } {
  let total = 0;
  let matched = 0;
  const breakdown: ScalarFieldResult[] = [];

  for (const field of SCALAR_FIELDS) {
    const exp = expected[field as ScalarField];
    const act = actual[field as ScalarField];

    if (exp === null) {
      // null expected = not applicable; not counted in accuracy.
      breakdown.push({ field, status: "skipped", expected: null, actual: act });
      continue;
    }

    total += 1;
    let status: ScalarFieldStatus;
    if (act === null) {
      status = "missing";
    } else if (normalize(act) === normalize(exp)) {
      status = "match";
      matched += 1;
    } else {
      status = "mismatch";
    }
    breakdown.push({ field, status, expected: exp, actual: act });
  }

  return { accuracy: total === 0 ? 1.0 : matched / total, breakdown };
}

// ---------------------------------------------------------------------------
// Skills scoring (Jaccard set overlap)
// ---------------------------------------------------------------------------

function scoreSkills(actual: LlmParsedResume, expected: LlmParsedResume): number {
  const expSet = new Set(expected.skills.map(normalize));
  const actSet = new Set(actual.skills.map(normalize));

  if (expSet.size === 0 && actSet.size === 0) return 1.0;

  let intersection = 0;
  for (const s of expSet) {
    if (actSet.has(s)) intersection += 1;
  }
  const union = expSet.size + actSet.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Experience scoring (key-field match)
// ---------------------------------------------------------------------------

function experienceKey(entry: { company: string; title: string }): string {
  return `${normalize(entry.company)}|${normalize(entry.title)}`;
}

function scoreExperience(actual: LlmParsedResume, expected: LlmParsedResume): number {
  if (expected.experience.length === 0) return 1.0;

  const actualKeys = new Set(actual.experience.map(experienceKey));
  let matched = 0;
  for (const entry of expected.experience) {
    if (actualKeys.has(experienceKey(entry))) matched += 1;
  }
  return matched / expected.experience.length;
}

// ---------------------------------------------------------------------------
// Education scoring (key-field match)
// ---------------------------------------------------------------------------

function educationKey(entry: { institution: string; degree: string }): string {
  return `${normalize(entry.institution)}|${normalize(entry.degree)}`;
}

function scoreEducation(actual: LlmParsedResume, expected: LlmParsedResume): number {
  if (expected.education.length === 0) return 1.0;

  const actualKeys = new Set(actual.education.map(educationKey));
  let matched = 0;
  for (const entry of expected.education) {
    if (actualKeys.has(educationKey(entry))) matched += 1;
  }
  return matched / expected.education.length;
}

// ---------------------------------------------------------------------------
// Per-fixture score
// ---------------------------------------------------------------------------

export function scoreFixture(
  fixtureId: string,
  fixtureLabel: string,
  actual: LlmParsedResume,
  expected: LlmParsedResume,
): FixtureScore {
  const scalar = scoreScalars(actual, expected);
  return {
    fixtureId,
    fixtureLabel,
    validJson: isValidJsonResult(actual),
    scalarAccuracy: scalar.accuracy,
    scalarBreakdown: scalar.breakdown,
    skillsAccuracy: scoreSkills(actual, expected),
    experienceAccuracy: scoreExperience(actual, expected),
    educationAccuracy: scoreEducation(actual, expected),
  };
}

// ---------------------------------------------------------------------------
// Aggregate across fixtures
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateScores(
  modelId: string,
  startedAt: string,
  scores: FixtureScore[],
): ParseEvalReport {
  return {
    modelId,
    startedAt,
    fixtures: scores,
    validJsonRate: mean(scores.map((s) => (s.validJson ? 1 : 0))),
    meanScalarAccuracy: mean(scores.map((s) => s.scalarAccuracy)),
    meanSkillsAccuracy: mean(scores.map((s) => s.skillsAccuracy)),
    meanExperienceAccuracy: mean(scores.map((s) => s.experienceAccuracy)),
    meanEducationAccuracy: mean(scores.map((s) => s.educationAccuracy)),
  };
}

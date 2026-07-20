// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Combined-pass eval scoring + comparison aggregation (issue #262, load-bearing
 * quality gate).
 *
 * The standalone parse eval (`./score.ts`) scores ONE pass against ground
 * truth. This module reuses that scorer to compare the SEPARATE pass
 * (`parseResumeWithLlm` + `critiqueResumeWithLlm`) against the COMBINED pass
 * (`analyzeResumeWithLlm`) per fixture, so a reviewer can see whether the
 * combined mega-prompt degraded either task on the pinned small model.
 *
 * Two things are measured:
 *
 *   1. **Parse-accuracy delta** — for each fixture, score the parse half of
 *      each pass against ground truth and report (combined − separate). The
 *      pass-merge AC requires this delta to be within an agreed tolerance.
 *
 *   2. **Critique structural stats** — `bulletFindings.length`,
 *      `missingSections.length`, and the per-issue count distribution. There
 *      is no fixture ground truth for critique quality (small-model judgment is
 *      subjective), so we report counts only. A large divergence between the
 *      two passes' counts is the red flag the reviewer is looking for.
 *
 * Pure over its inputs — no engine, no I/O. Deterministic and unit-testable.
 */

import type { LlmParsedResume } from "../parse-resume.ts";
import type { ResumeCritique } from "../critique-resume.ts";
import { scoreFixture, type FixtureScore } from "./score.ts";

// ── Critique structural stats ─────────────────────────────────────────────────

/**
 * Aggregate, content-free shape of one critique response. The eval has no
 * ground truth for critique quality (it's small-model judgment), so the
 * comparison is structural: a large per-pass divergence in bullet count or
 * flagged distribution is the reviewer's red flag, not a per-bullet accuracy.
 */
export interface CritiqueStats {
  bulletCount: number;
  flaggedCount: number;
  /** Per-issue tally — `ok` is the unflagged class, the rest are the flag kinds. */
  byIssue: {
    no_quantification: number;
    weak_verb: number;
    vague: number;
    ok: number;
  };
  missingSectionCount: number;
  /** True when the critique returned a non-empty summary note. */
  hasSummaryFeedback: boolean;
}

export function critiqueStats(critique: ResumeCritique): CritiqueStats {
  const byIssue: CritiqueStats["byIssue"] = {
    no_quantification: 0,
    weak_verb: 0,
    vague: 0,
    ok: 0,
  };
  for (const f of critique.bulletFindings) byIssue[f.issue]++;
  const flaggedCount = critique.bulletFindings.length - byIssue.ok;
  return {
    bulletCount: critique.bulletFindings.length,
    flaggedCount,
    byIssue,
    missingSectionCount: critique.missingSections.length,
    hasSummaryFeedback:
      typeof critique.summaryFeedback === "string" &&
      critique.summaryFeedback.trim().length > 0,
  };
}

// ── Per-fixture comparison record ────────────────────────────────────────────

export interface CombinedFixtureComparison {
  fixtureId: string;
  fixtureLabel: string;
  separate: {
    parse: FixtureScore;
    critique: CritiqueStats;
  };
  combined: {
    parse: FixtureScore;
    critique: CritiqueStats;
  };
}

/**
 * Build one fixture's comparison from the two passes' raw outputs and the
 * ground-truth expected parse. Both passes are scored against the same
 * fixture, so the delta the reviewer reads is apples-to-apples.
 */
export function compareFixture(args: {
  fixtureId: string;
  fixtureLabel: string;
  expected: LlmParsedResume;
  separateParse: LlmParsedResume;
  separateCritique: ResumeCritique;
  combinedParse: LlmParsedResume;
  combinedCritique: ResumeCritique;
}): CombinedFixtureComparison {
  return {
    fixtureId: args.fixtureId,
    fixtureLabel: args.fixtureLabel,
    separate: {
      parse: scoreFixture(
        args.fixtureId,
        args.fixtureLabel,
        args.separateParse,
        args.expected,
      ),
      critique: critiqueStats(args.separateCritique),
    },
    combined: {
      parse: scoreFixture(
        args.fixtureId,
        args.fixtureLabel,
        args.combinedParse,
        args.expected,
      ),
      critique: critiqueStats(args.combinedCritique),
    },
  };
}

// ── Aggregate report ─────────────────────────────────────────────────────────

export interface CombinedEvalReport {
  modelId: string;
  startedAt: string;
  fixtures: CombinedFixtureComparison[];
  /** Mean parse-accuracy means for each pass (so deltas are obvious at a glance). */
  separateMeans: ParseMeans;
  combinedMeans: ParseMeans;
  /** Mean critique stats (mostly diagnostic — no ground truth here). */
  separateCritiqueMeans: CritiqueMeans;
  combinedCritiqueMeans: CritiqueMeans;
}

export interface ParseMeans {
  validJsonRate: number;
  scalarAccuracy: number;
  skillsAccuracy: number;
  experienceAccuracy: number;
  educationAccuracy: number;
}

export interface CritiqueMeans {
  bulletCount: number;
  flaggedCount: number;
  missingSectionCount: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function parseMeansOf(scores: FixtureScore[]): ParseMeans {
  return {
    validJsonRate: mean(scores.map((s) => (s.validJson ? 1 : 0))),
    scalarAccuracy: mean(scores.map((s) => s.scalarAccuracy)),
    skillsAccuracy: mean(scores.map((s) => s.skillsAccuracy)),
    experienceAccuracy: mean(scores.map((s) => s.experienceAccuracy)),
    educationAccuracy: mean(scores.map((s) => s.educationAccuracy)),
  };
}

function critiqueMeansOf(stats: CritiqueStats[]): CritiqueMeans {
  return {
    bulletCount: mean(stats.map((s) => s.bulletCount)),
    flaggedCount: mean(stats.map((s) => s.flaggedCount)),
    missingSectionCount: mean(stats.map((s) => s.missingSectionCount)),
  };
}

export function aggregateCombinedReport(
  modelId: string,
  startedAt: string,
  comparisons: CombinedFixtureComparison[],
): CombinedEvalReport {
  return {
    modelId,
    startedAt,
    fixtures: comparisons,
    separateMeans: parseMeansOf(comparisons.map((c) => c.separate.parse)),
    combinedMeans: parseMeansOf(comparisons.map((c) => c.combined.parse)),
    separateCritiqueMeans: critiqueMeansOf(
      comparisons.map((c) => c.separate.critique),
    ),
    combinedCritiqueMeans: critiqueMeansOf(
      comparisons.map((c) => c.combined.critique),
    ),
  };
}

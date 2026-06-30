// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for the combined-pass eval comparison scorer (issue #262). Pure
 * logic — no engine, no fixtures from the inline resume corpus, no I/O.
 * These tests guard the structural shape of the comparison artifact so a
 * change to the report renderer can't silently drop a column the reviewer
 * relies on.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateCombinedReport,
  compareFixture,
  critiqueStats,
} from "./combined-score.ts";
import type { LlmParsedResume } from "../parse-resume.ts";
import type { ResumeCritique } from "../critique-resume.ts";

const PERFECT: LlmParsedResume = {
  full_name: "Jane Doe",
  email: "jane@example.com",
  phone: "(312) 555-0100",
  location: "Chicago, IL",
  summary: "Solid engineer.",
  skills: ["Python", "Go"],
  experience: [{ company: "Acme", title: "Engineer", description: "Did X." }],
  education: [{ institution: "State U", degree: "B.S." }],
};

function critique(overrides: Partial<ResumeCritique> = {}): ResumeCritique {
  return {
    bulletFindings: [
      { bullet: "led", issue: "no_quantification" },
      { bullet: "ok", issue: "ok" },
    ],
    missingSections: [],
    ...overrides,
  };
}

describe("critiqueStats", () => {
  it("tallies bullet findings by issue and counts flagged correctly", () => {
    const stats = critiqueStats({
      bulletFindings: [
        { bullet: "a", issue: "no_quantification" },
        { bullet: "b", issue: "weak_verb" },
        { bullet: "c", issue: "vague" },
        { bullet: "d", issue: "ok" },
        { bullet: "e", issue: "ok" },
      ],
      missingSections: ["skills", "summary"],
      summaryFeedback: "tighten it",
    });
    expect(stats.bulletCount).toBe(5);
    expect(stats.flaggedCount).toBe(3); // 5 total minus 2 ok
    expect(stats.byIssue).toEqual({
      no_quantification: 1,
      weak_verb: 1,
      vague: 1,
      ok: 2,
    });
    expect(stats.missingSectionCount).toBe(2);
    expect(stats.hasSummaryFeedback).toBe(true);
  });

  it("treats blank or whitespace summaryFeedback as absent", () => {
    expect(critiqueStats({ bulletFindings: [], missingSections: [], summaryFeedback: "   " }).hasSummaryFeedback).toBe(false);
    expect(critiqueStats({ bulletFindings: [], missingSections: [] }).hasSummaryFeedback).toBe(false);
  });
});

describe("compareFixture", () => {
  it("produces both per-pass parse scores and per-pass critique stats", () => {
    const result = compareFixture({
      fixtureId: "x",
      fixtureLabel: "X",
      expected: PERFECT,
      separateParse: PERFECT,
      separateCritique: critique(),
      combinedParse: PERFECT,
      combinedCritique: critique({
        bulletFindings: [{ bullet: "a", issue: "weak_verb" }],
      }),
    });
    expect(result.fixtureId).toBe("x");
    // Both passes were perfect on the parse half against a perfect ground truth.
    expect(result.separate.parse.scalarAccuracy).toBe(1);
    expect(result.combined.parse.scalarAccuracy).toBe(1);
    // Critique stats diverge — the comparison preserves that divergence.
    expect(result.separate.critique.bulletCount).toBe(2);
    expect(result.combined.critique.bulletCount).toBe(1);
  });
});

describe("aggregateCombinedReport", () => {
  it("means parse and critique stats across fixtures into both pass columns", () => {
    const f1 = compareFixture({
      fixtureId: "a",
      fixtureLabel: "A",
      expected: PERFECT,
      separateParse: PERFECT,
      separateCritique: critique(),
      combinedParse: PERFECT,
      combinedCritique: critique(),
    });
    const f2 = compareFixture({
      fixtureId: "b",
      fixtureLabel: "B",
      expected: PERFECT,
      separateParse: PERFECT,
      separateCritique: critique({
        bulletFindings: [
          { bullet: "x", issue: "weak_verb" },
          { bullet: "y", issue: "weak_verb" },
        ],
      }),
      combinedParse: PERFECT,
      combinedCritique: critique({
        bulletFindings: [{ bullet: "x", issue: "weak_verb" }],
      }),
    });
    const report = aggregateCombinedReport("test-model", "2026-06-29", [f1, f2]);
    expect(report.fixtures).toHaveLength(2);
    expect(report.separateMeans.scalarAccuracy).toBe(1);
    expect(report.combinedMeans.scalarAccuracy).toBe(1);
    // Bullet flagged means: separate (1, 2) → 1.5, combined (1, 1) → 1.
    expect(report.separateCritiqueMeans.flaggedCount).toBe(1.5);
    expect(report.combinedCritiqueMeans.flaggedCount).toBe(1);
  });
});

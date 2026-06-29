// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for the parse-eval scorer (issue #241).
 *
 * All tests are deterministic — no model, no engine. Covers each scoring
 * dimension independently plus the aggregate wrapper.
 */

import { describe, it, expect } from "vitest";
import {
  scoreFixture,
  aggregateScores,
  isValidJsonResult,
} from "./score.ts";
import type { LlmParsedResume } from "../parse-resume.ts";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const EMPTY: LlmParsedResume = {
  full_name: null,
  email: null,
  phone: null,
  location: null,
  summary: null,
  skills: [],
  experience: [],
  education: [],
};

const FULL: LlmParsedResume = {
  full_name: "Alex Rivera",
  email: "alex.rivera@example.com",
  phone: "(312) 555-0142",
  location: "Chicago, IL",
  summary: "Experienced engineer.",
  skills: ["Python", "Go", "PostgreSQL"],
  experience: [
    { company: "Meridian Tech", title: "Senior Engineer", description: "Led backend work." },
  ],
  education: [
    { institution: "Fenwick State University", degree: "B.S. Computer Science" },
  ],
};

// ---------------------------------------------------------------------------
// isValidJsonResult
// ---------------------------------------------------------------------------

describe("isValidJsonResult", () => {
  it("returns false for the empty shape", () => {
    expect(isValidJsonResult(EMPTY)).toBe(false);
  });

  it("returns true when any scalar is non-null", () => {
    expect(isValidJsonResult({ ...EMPTY, full_name: "Alex" })).toBe(true);
  });

  it("returns true when skills is non-empty", () => {
    expect(isValidJsonResult({ ...EMPTY, skills: ["Python"] })).toBe(true);
  });

  it("returns true when experience is non-empty", () => {
    expect(isValidJsonResult({
      ...EMPTY,
      experience: [{ company: "Acme", title: "Dev", description: "" }],
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scalar accuracy
// ---------------------------------------------------------------------------

describe("scoreFixture — scalar accuracy", () => {
  it("returns 1.0 when all expected scalars match", () => {
    const score = scoreFixture("f1", "label", FULL, FULL);
    expect(score.scalarAccuracy).toBe(1.0);
  });

  it("returns 0.0 when all expected scalars are wrong", () => {
    const actual: LlmParsedResume = { ...EMPTY };
    const score = scoreFixture("f1", "label", actual, FULL);
    expect(score.scalarAccuracy).toBe(0.0);
  });

  it("returns partial score for partial match", () => {
    const actual: LlmParsedResume = { ...FULL, email: null, phone: null };
    const score = scoreFixture("f1", "label", actual, FULL);
    // 5 scalar fields expected (full_name, email, phone, location, summary)
    // 3 matched (full_name, location, summary)
    expect(score.scalarAccuracy).toBeCloseTo(3 / 5);
  });

  it("skips null expected fields (not counted in denominator)", () => {
    const expected: LlmParsedResume = { ...EMPTY, full_name: "Alex" };
    const actual: LlmParsedResume = { ...EMPTY, full_name: "Alex" };
    const score = scoreFixture("f1", "label", actual, expected);
    expect(score.scalarAccuracy).toBe(1.0);
  });

  it("is case-insensitive for scalar comparison", () => {
    const actual: LlmParsedResume = { ...EMPTY, full_name: "ALEX RIVERA" };
    const expected: LlmParsedResume = { ...EMPTY, full_name: "alex rivera" };
    const score = scoreFixture("f1", "label", actual, expected);
    expect(score.scalarAccuracy).toBe(1.0);
  });

  it("returns 1.0 when all expected scalars are null (nothing to check)", () => {
    const score = scoreFixture("f1", "label", EMPTY, EMPTY);
    expect(score.scalarAccuracy).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Scalar field breakdown (per-field verdicts)
// ---------------------------------------------------------------------------

describe("scoreFixture — scalarBreakdown", () => {
  it("marks every applicable field 'match' on a perfect parse", () => {
    const score = scoreFixture("f1", "label", FULL, FULL);
    expect(score.scalarBreakdown).toHaveLength(5);
    expect(score.scalarBreakdown.every((s) => s.status === "match")).toBe(true);
  });

  it("names the missing field when actual is null", () => {
    const actual: LlmParsedResume = { ...FULL, location: null };
    const score = scoreFixture("f1", "label", actual, FULL);
    const loc = score.scalarBreakdown.find((s) => s.field === "location");
    expect(loc).toEqual({
      field: "location",
      status: "missing",
      expected: "Chicago, IL",
      actual: null,
    });
  });

  it("flags a mismatch with both expected and actual values", () => {
    const actual: LlmParsedResume = { ...FULL, summary: "Different summary." };
    const score = scoreFixture("f1", "label", actual, FULL);
    const sum = score.scalarBreakdown.find((s) => s.field === "summary");
    expect(sum).toEqual({
      field: "summary",
      status: "mismatch",
      expected: "Experienced engineer.",
      actual: "Different summary.",
    });
  });

  it("marks a null-expected field 'skipped' (not counted in accuracy)", () => {
    const expected: LlmParsedResume = { ...EMPTY, full_name: "Alex" };
    const score = scoreFixture("f1", "label", { ...EMPTY, full_name: "Alex" }, expected);
    const email = score.scalarBreakdown.find((s) => s.field === "email");
    expect(email?.status).toBe("skipped");
    // Only the one applicable field (full_name) drives accuracy.
    expect(score.scalarAccuracy).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Skills accuracy (Jaccard)
// ---------------------------------------------------------------------------

describe("scoreFixture — skills accuracy", () => {
  it("returns 1.0 for identical skill sets", () => {
    const score = scoreFixture("f1", "label", FULL, FULL);
    expect(score.skillsAccuracy).toBe(1.0);
  });

  it("returns 1.0 when both skill sets are empty", () => {
    const score = scoreFixture("f1", "label", EMPTY, EMPTY);
    expect(score.skillsAccuracy).toBe(1.0);
  });

  it("returns 0.0 when there is no overlap", () => {
    const actual = { ...EMPTY, skills: ["Java", "Rust"] };
    const expected = { ...EMPTY, skills: ["Python", "Go"] };
    const score = scoreFixture("f1", "label", actual, expected);
    expect(score.skillsAccuracy).toBe(0.0);
  });

  it("computes Jaccard correctly for partial overlap", () => {
    // intersection {Python} = 1, union {Python, Go, Java} = 3 → 1/3
    const actual = { ...EMPTY, skills: ["Python", "Java"] };
    const expected = { ...EMPTY, skills: ["Python", "Go"] };
    const score = scoreFixture("f1", "label", actual, expected);
    expect(score.skillsAccuracy).toBeCloseTo(1 / 3);
  });

  it("is case-insensitive for skills", () => {
    const actual = { ...EMPTY, skills: ["python", "go"] };
    const expected = { ...EMPTY, skills: ["Python", "Go"] };
    const score = scoreFixture("f1", "label", actual, expected);
    expect(score.skillsAccuracy).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Experience accuracy
// ---------------------------------------------------------------------------

describe("scoreFixture — experience accuracy", () => {
  it("returns 1.0 when all expected entries match by company+title", () => {
    const score = scoreFixture("f1", "label", FULL, FULL);
    expect(score.experienceAccuracy).toBe(1.0);
  });

  it("returns 1.0 when expected experience is empty", () => {
    const score = scoreFixture("f1", "label", EMPTY, EMPTY);
    expect(score.experienceAccuracy).toBe(1.0);
  });

  it("returns 0.0 when no expected entries match", () => {
    const actual: LlmParsedResume = {
      ...EMPTY,
      experience: [{ company: "Other Co", title: "Other Role", description: "" }],
    };
    const score = scoreFixture("f1", "label", actual, FULL);
    expect(score.experienceAccuracy).toBe(0.0);
  });

  it("is case-insensitive for company+title match", () => {
    const actual: LlmParsedResume = {
      ...EMPTY,
      experience: [{ company: "meridian tech", title: "senior engineer", description: "" }],
    };
    const score = scoreFixture("f1", "label", actual, FULL);
    expect(score.experienceAccuracy).toBe(1.0);
  });

  it("returns partial score when only some entries match", () => {
    const expected: LlmParsedResume = {
      ...EMPTY,
      experience: [
        { company: "Alpha", title: "Engineer", description: "" },
        { company: "Beta", title: "Lead", description: "" },
      ],
    };
    const actual: LlmParsedResume = {
      ...EMPTY,
      experience: [{ company: "Alpha", title: "Engineer", description: "" }],
    };
    const score = scoreFixture("f1", "label", actual, expected);
    expect(score.experienceAccuracy).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Education accuracy
// ---------------------------------------------------------------------------

describe("scoreFixture — education accuracy", () => {
  it("returns 1.0 for matching education", () => {
    const score = scoreFixture("f1", "label", FULL, FULL);
    expect(score.educationAccuracy).toBe(1.0);
  });

  it("returns 0.0 when institution+degree do not match", () => {
    const actual: LlmParsedResume = {
      ...EMPTY,
      education: [{ institution: "Other U", degree: "M.S. Math" }],
    };
    const score = scoreFixture("f1", "label", actual, FULL);
    expect(score.educationAccuracy).toBe(0.0);
  });

  it("returns 1.0 when expected education is empty", () => {
    const score = scoreFixture("f1", "label", EMPTY, EMPTY);
    expect(score.educationAccuracy).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// validJson flag
// ---------------------------------------------------------------------------

describe("scoreFixture — validJson", () => {
  it("is false when result is the empty shape", () => {
    const score = scoreFixture("f1", "label", EMPTY, FULL);
    expect(score.validJson).toBe(false);
  });

  it("is true when result has at least one non-null field", () => {
    const score = scoreFixture("f1", "label", FULL, FULL);
    expect(score.validJson).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aggregateScores
// ---------------------------------------------------------------------------

describe("aggregateScores", () => {
  it("computes mean across fixture scores", () => {
    const s1 = scoreFixture("f1", "F1", FULL, FULL);
    const s2 = scoreFixture("f2", "F2", EMPTY, FULL);
    const report = aggregateScores("test-model", "2026-01-01T00:00:00Z", [s1, s2]);

    expect(report.validJsonRate).toBeCloseTo(0.5);
    // scalarAccuracy: 1.0 and 0.0 → mean 0.5
    expect(report.meanScalarAccuracy).toBeCloseTo(0.5);
    expect(report.fixtures).toHaveLength(2);
    expect(report.modelId).toBe("test-model");
  });

  it("returns 0 for all means when given empty fixture list", () => {
    const report = aggregateScores("model", "2026-01-01T00:00:00Z", []);
    expect(report.validJsonRate).toBe(0);
    expect(report.meanScalarAccuracy).toBe(0);
  });
});

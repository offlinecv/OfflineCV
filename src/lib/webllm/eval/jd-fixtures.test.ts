// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { getJdEvalFixtureById, JD_EVAL_FIXTURES, parseJdFixture } from "./jd-fixtures.ts";

describe("JD_EVAL_FIXTURES", () => {
  it("loads all 5 fixtures from tests/fixtures/jd-eval/", () => {
    expect(JD_EVAL_FIXTURES.map((f) => f.id)).toEqual([
      "music-intern",
      "software-engineer",
      "years-mismatch",
      "transferable-skill",
      "prompt-injection",
    ]);
  });

  it("every fixture carries non-empty jd/resume text and at least one gold label", () => {
    for (const fixture of JD_EVAL_FIXTURES) {
      expect(fixture.jd.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.resume.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.gold.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.canned.path, fixture.id).toBe("semantic");
    }
  });

  it("only the prompt-injection fixture carries an injectionPayload", () => {
    for (const fixture of JD_EVAL_FIXTURES) {
      if (fixture.id === "prompt-injection") {
        expect(fixture.injectionPayload).toBeTruthy();
      } else {
        expect(fixture.injectionPayload).toBeUndefined();
      }
    }
  });

  it("derives canned.summary from the canned verdicts rather than trusting an authored value", () => {
    const fixture = getJdEvalFixtureById("software-engineer");
    expect(fixture).toBeDefined();
    if (fixture?.canned.path === "semantic") {
      expect(fixture.canned.summary).toEqual({
        met: fixture.canned.verdicts.length,
        partial: 0,
        missing: 0,
        total: fixture.canned.verdicts.length,
      });
    }
  });
});

describe("parseJdFixture", () => {
  const valid = {
    id: "demo",
    description: "demo fixture",
    jd: "We need React.",
    resume: "I know React.",
    gold: [{ text: "React", kind: "skill", expectedStatus: "met" }],
    canned: {
      path: "semantic",
      verdicts: [
        {
          requirement: { id: "req-1", kind: "skill", text: "React" },
          status: "met",
          reason: "The résumé lists React experience.",
        },
      ],
    },
  };

  it("parses a well-formed fixture", () => {
    expect(() => parseJdFixture(valid, "inline")).not.toThrow();
  });

  it("throws with the source path when 'id' is missing", () => {
    const { id: _id, ...rest } = valid;
    expect(() => parseJdFixture(rest, "inline/bad.json")).toThrow(/inline\/bad\.json/);
  });

  it("throws on an unknown gold 'kind'", () => {
    const bad = { ...valid, gold: [{ text: "x", kind: "nonsense", expectedStatus: "met" }] };
    expect(() => parseJdFixture(bad, "inline")).toThrow(/kind/);
  });

  it("throws on an unknown verdict 'status'", () => {
    const bad = {
      ...valid,
      canned: {
        path: "semantic",
        verdicts: [
          {
            requirement: { id: "req-1", kind: "skill", text: "React" },
            status: "nonsense",
            reason: "x",
          },
        ],
      },
    };
    expect(() => parseJdFixture(bad, "inline")).toThrow(/status/);
  });
});

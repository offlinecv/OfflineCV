// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import { extractJdTerms } from "./extract-jd-terms.ts";
import {
  computeCoverage,
  buildCorpus,
  buildResumeProjection,
  SKILL_WEIGHT,
  NOUN_WEIGHT,
} from "./coverage.ts";

function makeParsed(overrides: Partial<HeuristicParsedResume> = {}): HeuristicParsedResume {
  return {
    skills: [],
    experience: [],
    education: [],
    ...overrides,
  };
}

describe("buildResumeProjection", () => {
  it("preserves case and equals buildCorpus once lowercased (#201)", () => {
    const parsed = makeParsed({
      summary: "Backend Engineer",
      skills: ["TypeScript"],
      experience: [{ title: "Staff Engineer", company: "Acme", description: "Owned Kafka" }],
    });
    const projection = buildResumeProjection(parsed);
    expect(projection).toContain("TypeScript"); // not lowercased
    expect(projection).toContain("Staff Engineer");
    expect(buildCorpus(parsed)).toBe(projection.toLowerCase());
  });
});

describe("buildCorpus", () => {
  it("flattens summary, skills, experience, and education into a single lowercased string", () => {
    const corpus = buildCorpus(
      makeParsed({
        summary: "Backend engineer.",
        skills: ["Python", "TypeScript"],
        experience: [
          {
            title: "Staff Engineer",
            company: "Acme",
            description: "Owned Kafka and Postgres pipelines.",
          },
        ],
        education: [{ degree: "B.S. CS", institution: "State U" }],
      }),
    );
    expect(corpus).toContain("backend engineer");
    expect(corpus).toContain("python");
    expect(corpus).toContain("kafka");
    expect(corpus).toContain("state u");
    // Lowercased.
    expect(corpus).not.toMatch(/[A-Z]/);
  });
});

describe("computeCoverage", () => {
  const jd = `
We're hiring a backend engineer fluent in Go and Kubernetes.
You'll work with PostgreSQL, Redis, and Apache Kafka.
Familiarity with Distributed Systems is a plus.
`;
  const { all } = extractJdTerms(jd);

  it("marks aliased skills as covered when the resume mentions any alias", () => {
    const parsed = makeParsed({
      experience: [
        {
          title: "Engineer",
          company: "Acme",
          description: "Built infra on k8s with postgres and kafka.",
        },
      ],
    });
    const cov = computeCoverage(parsed, all);
    const coveredIds = cov.covered.map((t) => t.id);
    expect(coveredIds).toEqual(
      expect.arrayContaining(["kubernetes", "postgresql", "kafka"]),
    );
  });

  it("marks JD terms missing when the resume doesn't mention them", () => {
    const parsed = makeParsed({
      summary: "I write a lot of Python.",
    });
    const cov = computeCoverage(parsed, all);
    const missingIds = cov.missing.map((t) => t.id);
    expect(missingIds).toEqual(expect.arrayContaining(["kubernetes", "redis"]));
  });

  it("returns score 100 when the resume covers every JD term", () => {
    const parsed = makeParsed({
      summary:
        "Built distributed systems with Go, Kubernetes, PostgreSQL, Redis, and Apache Kafka.",
    });
    const cov = computeCoverage(parsed, all);
    expect(cov.score).toBe(100);
    expect(cov.missing).toHaveLength(0);
  });

  it("returns score 0 when no JD term is mentioned", () => {
    const parsed = makeParsed({
      summary: "Designer with a focus on typography.",
    });
    const cov = computeCoverage(parsed, all);
    expect(cov.score).toBe(0);
    expect(cov.covered).toHaveLength(0);
  });

  it("weights skill matches 1.0 and noun matches 0.5", () => {
    const parsed = makeParsed({ summary: "" });
    const onlySkill = computeCoverage(parsed, [
      { id: "react", display: "react", source: "skill", snippet: "" },
    ]);
    const onlyNoun = computeCoverage(parsed, [
      { id: "anything", display: "Anything", source: "noun", snippet: "" },
    ]);
    expect(onlySkill.weights.skill).toBe(SKILL_WEIGHT);
    expect(onlyNoun.weights.noun).toBe(NOUN_WEIGHT);

    // A 50/50 mix where the skill is covered and the noun is missing
    // weights the skill at 1.0 / 1.5 ≈ 67%.
    const mixed = computeCoverage(
      makeParsed({ summary: "I use React daily." }),
      [
        { id: "react", display: "react", source: "skill", snippet: "" },
        { id: "vague", display: "Vague Phrase", source: "noun", snippet: "" },
      ],
    );
    expect(mixed.score).toBe(67);
  });

  it("returns score 0 with no terms (avoids divide-by-zero)", () => {
    const cov = computeCoverage(makeParsed(), []);
    expect(cov.score).toBe(0);
    expect(cov.covered).toHaveLength(0);
    expect(cov.missing).toHaveLength(0);
  });
});

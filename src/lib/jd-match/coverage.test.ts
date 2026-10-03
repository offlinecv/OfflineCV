// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { ExtractedTerm } from "./extract-jd-terms.ts";
import { extractJdTerms } from "./extract-jd-terms.ts";
import {
  computeCoverage,
  computeCoverageFromCorpus,
  buildCorpus,
  buildResumeProjection,
  SKILL_WEIGHT,
  NOUN_WEIGHT,
  PHRASE_HEAD_INFLECTION_PAIRS,
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

  it("projects an education entry's field of study, not just the credential", () => {
    // The extractor splits a degree line into a bare credential + its subject
    // (`extract/education.ts`), so `degree` alone carries no subject at all.
    // Measured on a real résumé: a posting requiring "Computer Science" scored
    // it MISSING against a CS graduate because only `degree` was projected.
    const parsed = makeParsed({
      education: [
        {
          degree: "Bachelor of Technology",
          field: "Computer Science & Engineering",
          institution: "JNTU College of Engineering",
        },
      ],
    });
    const coverage = computeCoverage(
      parsed,
      extractJdTerms("BS or MS in Computer Science required.").all,
    );
    expect(coverage.covered.map((t) => t.display)).toContain("Computer Science");
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
        education: [{ degree: "Bachelor of Technology", institution: "State University" }],
      }),
    );
    expect(corpus).toContain("backend engineer");
    expect(corpus).toContain("python");
    expect(corpus).toContain("kafka");
    expect(corpus).toContain("state university");
    // Lowercased — except acronym-shaped words, covered separately below.
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

// Noun-pass phrase matching keeps the literal match as the primary test and
// only retries, once, with the phrase's final word swapped against an
// explicit pair table (#847) — not a general stemmer. See the module
// docblock on `corpusMentionsPhrase` for why the stemmer version was
// withdrawn.
describe("noun-phrase head-swap retry (#847)", () => {
  it("credits an all-caps résumé plural against a JD singular of the same head noun", () => {
    const parsed = makeParsed({
      summary: "Backend engineer who has built large DISTRIBUTED SYSTEMS for a decade.",
    });
    const term: ExtractedTerm = {
      id: "distributed system",
      display: "Distributed System",
      source: "noun",
      snippet: "",
    };
    const cov = computeCoverage(parsed, [term]);
    expect(cov.covered).toContain(term);
    expect(cov.missing).toHaveLength(0);
  });

  it("credits a pair-table swap (bias/biases) and a literal singular match (lens) side by side", () => {
    const parsed = makeParsed({
      summary:
        "Reduced biases across the model and documented findings through a research lens.",
    });
    const terms: ExtractedTerm[] = [
      { id: "bias", display: "Bias", source: "noun", snippet: "" },
      { id: "lens", display: "Lens", source: "noun", snippet: "" },
    ];
    const cov = computeCoverage(parsed, terms);
    expect(cov.covered).toEqual(terms);
    expect(cov.missing).toHaveLength(0);
  });

  it("swaps both directions — JD plural covered by a résumé singular, and the reverse", () => {
    const pluralTerm: ExtractedTerm = {
      id: "distributed systems",
      display: "Distributed Systems",
      source: "noun",
      snippet: "",
    };
    const singularResume = makeParsed({ summary: "Built a reliable distributed system." });
    expect(computeCoverage(singularResume, [pluralTerm]).covered).toContain(pluralTerm);

    const singularTerm: ExtractedTerm = {
      id: "distributed system",
      display: "Distributed System",
      source: "noun",
      snippet: "",
    };
    const pluralResume = makeParsed({ summary: "Built large distributed systems." });
    expect(computeCoverage(pluralResume, [singularTerm]).covered).toContain(singularTerm);
  });

  it("still reports a JD noun phrase missing when the résumé addresses it in genuinely different words", () => {
    // Same head noun ("rotation") as an on-call requirement, but the words
    // around it differ — a head-noun swap doesn't bridge this; it stays
    // #156's job, not this heuristic's.
    const parsed = makeParsed({
      experience: [
        {
          title: "Staff Engineer",
          company: "Acme",
          description: "Owned the production support rotation for six services.",
        },
      ],
    });
    const term: ExtractedTerm = {
      id: "on-call rotation",
      display: "On-Call Rotation",
      source: "noun",
      snippet: "",
    };
    const cov = computeCoverage(parsed, [term]);
    expect(cov.missing).toContain(term);
    expect(cov.covered).toHaveLength(0);
  });

  it("behaves exactly as the literal match on main when the phrase's head noun is not in the pair table", () => {
    // No determiner-dropping, no modifier-dropping, no suffix rule: a head
    // noun absent from `PHRASE_HEAD_INFLECTION_PAIRS` gets no swap at all,
    // even when it merely ends in "s".
    const parsed = makeParsed({
      summary: "Comfortable with Kubernetes but new to Terraform.",
    });
    const kubernetes: ExtractedTerm = {
      id: "kubernetes",
      display: "Kubernetes",
      source: "noun",
      snippet: "",
    };
    const terraforms: ExtractedTerm = {
      id: "terraforms",
      display: "Terraforms",
      source: "noun",
      snippet: "",
    };
    const cov = computeCoverage(parsed, [kubernetes, terraforms]);
    expect(cov.covered).toEqual([kubernetes]);
    expect(cov.missing).toEqual([terraforms]);
  });

  it("pins the pair table to exactly the set #847 seeds — a trim or a stray addition must show up here", () => {
    const singulars = PHRASE_HEAD_INFLECTION_PAIRS.map(([singular]) => singular).sort();
    expect(singulars).toEqual(
      [
        "system",
        "bias",
        "lens",
        "responsibility",
        "service",
        "function",
        "qualification",
        "demand",
        "app",
        "team",
        "keyword",
      ].sort(),
    );
  });
});

// The corpus seam (#700). `computeCoverage` is now a thin wrapper, so the two
// entry points must stay one implementation — a caller holding only the
// lowercased digest must score identically to one holding the whole résumé.
describe("computeCoverageFromCorpus", () => {
  const parsed = makeParsed({
    summary: "Backend engineer who ships.",
    skills: ["TypeScript", "Kubernetes"],
    experience: [
      { title: "Staff Engineer", company: "Acme", description: "Owned the Kafka pipeline." },
    ],
  });
  const terms = extractJdTerms(
    "We need a TypeScript engineer with Kubernetes experience and a Kafka pipeline background. Terraform is a plus.",
  ).all;

  it("is what computeCoverage delegates to — identical result for the same résumé", () => {
    // Guard: an empty term list, or one nothing covers, would make this vacuous.
    expect(terms.length).toBeGreaterThan(0);
    const viaCorpus = computeCoverageFromCorpus(buildCorpus(parsed), terms);
    expect(viaCorpus.covered.length).toBeGreaterThan(0);
    expect(viaCorpus).toEqual(computeCoverage(parsed, terms));
  });

  it("scores from a corpus string alone, with no HeuristicParsedResume in hand", () => {
    const cov = computeCoverageFromCorpus("typescript, kubernetes, kafka", terms);
    expect(cov.covered.map((t) => t.id)).toEqual(
      expect.arrayContaining(["typescript", "kubernetes"]),
    );
    expect(cov.score).toBeGreaterThan(0);
  });
});

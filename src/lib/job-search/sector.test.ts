// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifySectorHeuristic,
  SECTORS,
  isSector,
} from "./sector.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";

// Minimal typed stub over the parsed model, like contact.test.ts — only the
// fields sector.ts reads (skills + experience titles/companies).
function makeParsed(
  overrides: Partial<HeuristicParsedResume> = {},
): HeuristicParsedResume {
  return {
    skills: [],
    experience: [],
    education: [],
    ...overrides,
  };
}

describe("classifySectorHeuristic", () => {
  it("maps a clearly-fintech skill/title set to fintech", () => {
    const parsed = makeParsed({
      skills: ["Payments", "KYC", "Fraud Detection"],
      experience: [
        { title: "Senior Payments Engineer", company: "Stripe" },
      ],
    });
    const guess = classifySectorHeuristic(parsed);
    expect(guess.sector).toBe("fintech");
    expect(guess.source).toBe("heuristic");
    expect(guess.confidence).toBeGreaterThan(0);
  });

  it("maps a clearly-devtools skill/title set to devtools", () => {
    const parsed = makeParsed({
      skills: ["Kubernetes", "CI/CD", "SDK design"],
      experience: [{ title: "Developer Experience Engineer", company: "Acme CLI" }],
    });
    const guess = classifySectorHeuristic(parsed);
    expect(guess.sector).toBe("devtools");
  });

  it("maps a clearly-data-ml skill/title set to data-ml", () => {
    const parsed = makeParsed({
      skills: ["PyTorch", "Machine Learning", "MLOps"],
      experience: [{ title: "ML Engineer", company: "Data Co" }],
    });
    const guess = classifySectorHeuristic(parsed);
    expect(guess.sector).toBe("data-ml");
  });

  it("returns other with low confidence for an empty resume, never throws", () => {
    const parsed = makeParsed();
    expect(() => classifySectorHeuristic(parsed)).not.toThrow();
    const guess = classifySectorHeuristic(parsed);
    expect(guess.sector).toBe("other");
    expect(guess.confidence).toBe(0);
    expect(guess.runnerUp).toBeUndefined();
  });

  it("returns other with low confidence for a degenerate resume with unrelated words", () => {
    const parsed = makeParsed({
      skills: ["Communication", "Teamwork"],
      experience: [{ title: "Generalist", company: "Somewhere Inc" }],
    });
    const guess = classifySectorHeuristic(parsed);
    expect(guess.sector).toBe("other");
    expect(guess.confidence).toBe(0);
  });

  it("populates runnerUp when two sectors both score above the floor", () => {
    const parsed = makeParsed({
      skills: ["Payments", "Kubernetes", "CI/CD"],
      experience: [{ title: "Payments Platform / DevEx Engineer", company: "Acme" }],
    });
    const guess = classifySectorHeuristic(parsed);
    expect(guess.runnerUp).toBeDefined();
    expect(guess.runnerUp).not.toBe(guess.sector);
  });

  // Share-of-top-two alone gives a lone keyword hit confidence 1.0, because
  // every sector is scored so the runner-up is 0. The evidence factor has to
  // pull it below a well-evidenced multi-hit guess.
  it("rates a single-hit guess below a well-evidenced one", () => {
    const oneHit = classifySectorHeuristic(
      makeParsed({
        skills: ["React", "Route optimization"],
        experience: [{ title: "Frontend Engineer", company: "Acme" }],
      }),
    );
    const wellEvidenced = classifySectorHeuristic(
      makeParsed({
        skills: ["Data warehouse", "ETL", "Spark"],
        experience: [{ title: "Data Engineer", company: "Acme" }],
      }),
    );
    expect(oneHit.sector).toBe("logistics-mobility");
    expect(wellEvidenced.sector).toBe("data-ml");
    expect(oneHit.confidence).toBeLessThan(wellEvidenced.confidence);
    expect(oneHit.confidence).toBeLessThan(1);
  });

  // Single tokens that live inside another family's phrase ("data warehouse",
  // "Kafka streaming", "NFT marketplace") must not score their own family.
  it("does not score a family off a token borrowed from another family's phrase", () => {
    const guess = classifySectorHeuristic(
      makeParsed({
        skills: ["Data warehouse", "Kafka streaming", "ETL", "Spark"],
        experience: [{ title: "Data Engineer", company: "Acme" }],
      }),
    );
    expect(guess.sector).toBe("data-ml");
    expect(guess.runnerUp).toBeUndefined();
  });
});

describe("isSector", () => {
  it("accepts every taxonomy value", () => {
    for (const sector of SECTORS) {
      expect(isSector(sector)).toBe(true);
    }
  });

  it("rejects off-taxonomy strings and non-strings", () => {
    expect(isSector("not-a-sector")).toBe(false);
    expect(isSector(undefined)).toBe(false);
    expect(isSector(42)).toBe(false);
  });
});

describe("classifySector", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the heuristic result unchanged when WebGPU is unavailable", async () => {
    vi.doMock("../webllm/capability.ts", () => ({
      detectWebGpu: vi.fn().mockResolvedValue("no-webgpu"),
    }));
    const { classifySector: classify } = await import("./sector.ts");

    const parsed = makeParsed({
      skills: ["Payments", "KYC"],
      experience: [{ title: "Payments Engineer", company: "Stripe" }],
    });
    const guess = await classify(parsed);
    expect(guess.source).toBe("heuristic");
    expect(guess.sector).toBe("fintech");
  });

  it("falls back to heuristic when the semantic response is off-taxonomy", async () => {
    vi.doMock("../webllm/capability.ts", () => ({
      detectWebGpu: vi.fn().mockResolvedValue("available"),
    }));
    vi.doMock("../webllm/web-llm.ts", () => ({
      loadEngine: vi.fn().mockResolvedValue({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"sector": "not-a-real-sector"}' } }],
            }),
          },
        },
      }),
      acquireInference: vi.fn(),
      releaseInference: vi.fn(),
    }));
    vi.doMock("../webllm/models.ts", () => ({
      DEFAULT_MODEL_ID: "test-model",
    }));

    const { classifySector: classify } = await import("./sector.ts");
    const parsed = makeParsed({
      skills: ["Payments", "KYC"],
      experience: [{ title: "Payments Engineer", company: "Stripe" }],
    });
    const guess = await classify(parsed);
    expect(guess.source).toBe("heuristic");
    expect(guess.sector).toBe("fintech");
  });

  it("returns the semantic result when the engine gives a valid taxonomy value", async () => {
    vi.doMock("../webllm/capability.ts", () => ({
      detectWebGpu: vi.fn().mockResolvedValue("available"),
    }));
    vi.doMock("../webllm/web-llm.ts", () => ({
      loadEngine: vi.fn().mockResolvedValue({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"sector": "devtools"}' } }],
            }),
          },
        },
      }),
      acquireInference: vi.fn(),
      releaseInference: vi.fn(),
    }));
    vi.doMock("../webllm/models.ts", () => ({
      DEFAULT_MODEL_ID: "test-model",
    }));

    const { classifySector: classify } = await import("./sector.ts");
    const parsed = makeParsed({
      skills: ["Payments"],
      experience: [{ title: "Payments Engineer", company: "Stripe" }],
    });
    const guess = await classify(parsed);
    expect(guess.source).toBe("semantic");
    expect(guess.sector).toBe("devtools");
  });

  it("falls back to heuristic when the engine call throws", async () => {
    vi.doMock("../webllm/capability.ts", () => ({
      detectWebGpu: vi.fn().mockResolvedValue("available"),
    }));
    vi.doMock("../webllm/web-llm.ts", () => ({
      loadEngine: vi.fn().mockRejectedValue(new Error("engine load failed")),
      acquireInference: vi.fn(),
      releaseInference: vi.fn(),
    }));
    vi.doMock("../webllm/models.ts", () => ({
      DEFAULT_MODEL_ID: "test-model",
    }));

    const { classifySector: classify } = await import("./sector.ts");
    const parsed = makeParsed({
      skills: ["Payments"],
      experience: [{ title: "Payments Engineer", company: "Stripe" }],
    });
    const guess = await classify(parsed);
    expect(guess.source).toBe("heuristic");
    expect(guess.sector).toBe("fintech");
  });
});

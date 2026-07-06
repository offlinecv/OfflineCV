// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for runLlmMatch (#202) — the semantic orchestrator's two
 * branches, driven by stubs (no WebGPU): the happy path assembles a
 * `semantic` result from the collaborators' outputs, and EVERY failure mode
 * (engine load error, extraction hard-failure, empty extraction, unexpected
 * judge error) resolves to a keyword result that matches a fresh
 * `extractJdTerms` + `computeCoverage` computation exactly — fallback parity,
 * proven the same way rank parity is (#319-style independent recompute).
 *
 * `loadEngine` / `extractRequirements` / `judgeEvidence` are mocked at their
 * module boundary; the keyword-path functions stay REAL so the fallback
 * assertion exercises the actual deterministic pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the engine loader (and the inference-guard exports judge-evidence's
// module-level imports resolve against, so importing it stays loadable).
vi.mock("../../webllm/web-llm.ts", () => ({
  loadEngine: vi.fn(),
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

// Mock the two LLM calls; keep the real RequirementExtractionError class so
// the thrown-error test uses the same type the production extractor throws.
vi.mock("./extract-requirements.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./extract-requirements.ts")>();
  return { ...actual, extractRequirements: vi.fn() };
});
vi.mock("./judge-evidence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judge-evidence.ts")>();
  return { ...actual, judgeEvidence: vi.fn() };
});

import { runLlmMatch } from "./run-llm-match.ts";
import { loadEngine } from "../../webllm/web-llm.ts";
import {
  extractRequirements,
  RequirementExtractionError,
  type JdRequirement,
} from "./extract-requirements.ts";
import { judgeEvidence, type RequirementVerdict } from "./judge-evidence.ts";
import { extractJdTerms } from "../extract-jd-terms.ts";
import { computeCoverage } from "../coverage.ts";
import type { WebLlmEngine } from "../../webllm/types.ts";
import type { HeuristicParsedResume } from "../../heuristics/types.ts";

const loadEngineMock = vi.mocked(loadEngine);
const extractMock = vi.mocked(extractRequirements);
const judgeMock = vi.mocked(judgeEvidence);

const MODEL = "test-model";
const JD_TEXT =
  "We are hiring a backend engineer. Requires TypeScript and Go. " +
  "Kubernetes experience is a plus.";

const engine: WebLlmEngine = {
  chat: { completions: { create: vi.fn() } },
};

function parsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Example",
    skills: ["TypeScript", "Go"],
    experience: [
      {
        company: "Acme",
        title: "Backend Engineer",
        description: "Built TypeScript services",
        is_current: false,
      },
    ],
    education: [],
  };
}

function req(id: string, text: string): JdRequirement {
  return { id, kind: "skill", text };
}

function verdict(
  id: string,
  status: RequirementVerdict["status"],
): RequirementVerdict {
  return {
    requirement: req(id, `text for ${id}`),
    status,
    reason: `reason for ${id}`,
  };
}

/** The exact keyword result the fallback must reproduce. */
function freshKeywordResult(resume: HeuristicParsedResume) {
  const extracted = extractJdTerms(JD_TEXT);
  return {
    path: "keyword" as const,
    coverage: computeCoverage(resume, extracted.all),
    terms: extracted.all,
    nounsDropped: extracted.nounsDropped,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The fallback branch warns; keep test output clean and assertable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  loadEngineMock.mockResolvedValue(engine);
});

describe("runLlmMatch — happy path", () => {
  it("assembles a semantic result: verdicts passed through, summary tallied", async () => {
    const requirements = [req("req-1", "TypeScript"), req("req-2", "Go"), req("req-3", "Kubernetes"), req("req-4", "GraphQL")];
    const verdicts = [
      verdict("req-1", "met"),
      verdict("req-2", "met"),
      verdict("req-3", "partial"),
      verdict("req-4", "missing"),
    ];
    extractMock.mockResolvedValue(requirements);
    judgeMock.mockResolvedValue(verdicts);

    const onProgress = vi.fn();
    const result = await runLlmMatch(JD_TEXT, parsed(), MODEL, onProgress);

    expect(result.path).toBe("semantic");
    if (result.path !== "semantic") throw new Error("unreachable");
    expect(result.verdicts).toBe(verdicts);
    expect(result.summary).toEqual({ met: 2, partial: 1, missing: 1, total: 4 });
  });

  it("threads jdText, engine, modelId, and onProgress to the right collaborators", async () => {
    const resume = parsed();
    const requirements = [req("req-1", "TypeScript")];
    extractMock.mockResolvedValue(requirements);
    judgeMock.mockResolvedValue([verdict("req-1", "met")]);

    const onProgress = vi.fn();
    await runLlmMatch(JD_TEXT, resume, MODEL, onProgress);

    expect(loadEngineMock).toHaveBeenCalledExactlyOnceWith(MODEL, onProgress);
    expect(extractMock).toHaveBeenCalledExactlyOnceWith(JD_TEXT, engine);
    expect(judgeMock).toHaveBeenCalledExactlyOnceWith(
      requirements,
      resume,
      engine,
      MODEL,
    );
  });
});

describe("runLlmMatch — fallback discipline (every failure → keyword, never a rejection)", () => {
  it("falls back when the engine load fails (also the no-WebGPU manifestation)", async () => {
    loadEngineMock.mockRejectedValue(new Error("WebGPU unavailable"));

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result).toEqual(freshKeywordResult(resume));
    expect(extractMock).not.toHaveBeenCalled();
    expect(judgeMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("falls back when extraction hard-fails (RequirementExtractionError)", async () => {
    extractMock.mockRejectedValue(
      new RequirementExtractionError("no parseable JSON array"),
    );

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result).toEqual(freshKeywordResult(resume));
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it("falls back on a valid-but-empty extraction (zero verdicts = blank panel)", async () => {
    extractMock.mockResolvedValue([]);

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result.path).toBe("keyword");
    expect(judgeMock).not.toHaveBeenCalled();
    // Not an error — the extractor succeeded — so no warning is logged.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back if the judge throws unexpectedly (defensive; its contract is never-throw)", async () => {
    extractMock.mockResolvedValue([req("req-1", "TypeScript")]);
    judgeMock.mockRejectedValue(new Error("engine evicted mid-batch"));

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result).toEqual(freshKeywordResult(resume));
  });

  it("fallback parity: the keyword result matches the JD-fit surface's own composition exactly", async () => {
    loadEngineMock.mockRejectedValue(new Error("boom"));

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());
    const fresh = freshKeywordResult(resume);

    if (result.path !== "keyword") throw new Error("expected keyword path");
    expect(result.coverage.score).toBe(fresh.coverage.score);
    expect(result.terms.length).toBeGreaterThan(0);
    expect(result.terms).toEqual(fresh.terms);
    expect(result.nounsDropped).toBe(fresh.nounsDropped);
  });
});

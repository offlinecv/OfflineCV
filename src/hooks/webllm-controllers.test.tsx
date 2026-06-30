// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Lifecycle coverage for the two WebGPU-gated WebLLM controllers (#262/#243):
 * `useResumeAnalysisLlm` (the unified parse+critique controller that replaced
 * `useParseDisagreement` + `useResumeCritique`) and `useLlmEscapeHatch`.
 *
 * The engine layer (capability probe, loadEngine, the combined analysis pass,
 * the escape-hatch parse pass, model selection, analytics) is mocked, so these
 * tests exercise the React/state glue only — availability gating, the
 * idle→loading→done happy path, and the error path — via a probe component
 * (the project has no RTL; same pattern as the other hook tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { SectionName } from "../lib/heuristics/regex.ts";

// ── Mocks (engine layer only) ──────────────────────────────────────────────────

let webgpu: "available" | "unavailable" = "available";
let loadShouldThrow = false;

vi.mock("../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve(webgpu),
}));

vi.mock("../lib/webllm/web-llm.ts", () => ({
  loadEngine: (_id: string, onProgress: (p: unknown) => void) => {
    onProgress({ progress: 0.5, text: "Loading…" });
    if (loadShouldThrow) return Promise.reject(new Error("load failed"));
    return Promise.resolve({ chat: {} });
  },
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

vi.mock("../lib/webllm/analyze-resume.ts", () => ({
  analyzeResumeWithLlm: () =>
    Promise.resolve({
      parse: {
        full_name: "LLM Name",
        email: null,
        phone: null,
        location: null,
        summary: null,
        skills: [],
        experience: [],
        education: [],
      },
      critique: {
        bulletFindings: [
          { bullet: "x", issue: "weak_verb" },
          { bullet: "y", issue: "ok" },
        ],
        missingSections: ["skills"],
      },
    }),
}));

vi.mock("../lib/webllm/parse-resume.ts", () => ({
  parseResumeWithLlm: () =>
    Promise.resolve({
      full_name: "LLM Name",
      email: null,
      phone: null,
      location: null,
      summary: null,
      skills: [],
      experience: [],
      education: [],
    }),
}));

vi.mock("./useModelSelection.ts", () => ({
  useModelSelection: () => ({ selectedModelId: "test-model" }),
}));

vi.mock("../lib/analytics.ts", () => ({
  trackLlmParseRan: vi.fn(),
  trackDisagreementsFound: vi.fn(),
  trackLlmFallbackRan: vi.fn(),
  trackCritiqueRan: vi.fn(),
}));

import { useResumeAnalysisLlm } from "./useResumeAnalysisLlm.ts";
import { useLlmEscapeHatch } from "./useLlmEscapeHatch.ts";
import { acquireInference, releaseInference } from "../lib/webllm/web-llm.ts";
import {
  trackLlmParseRan,
  trackDisagreementsFound,
  trackCritiqueRan,
} from "../lib/analytics.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function sectioned(): SectionedResume {
  const byName = new Map<SectionName | "profile", readonly string[]>([
    ["experience", ["a bullet"]],
  ]);
  return { byName, accomplishmentSections: ["experience"], source: "regex" };
}

function result(): CascadeResult {
  return {
    parsed: {
      full_name: "Orig",
      email: "orig@example.com",
      skills: ["s"],
      experience: [
        { company: "Co", title: "T", description: "did a thing", is_current: false },
      ],
      education: [],
    },
    confidence: 0.4,
    fieldConfidence: {},
    triggers: ["two_column"],
    suggestedEscalation: "llm",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "some extractable text",
    markdown: "some extractable text",
    sections: sectioned(),
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 20, pages: 1, elapsedMs: 5 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

let container: HTMLDivElement;
let root: Root;

// Mount a probe that publishes the controller into `sink` on every render.
async function mount<T>(useHook: () => T, sink: { current: T | null }) {
  function Probe() {
    sink.current = useHook();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  // Let the async WebGPU probe settle so `isAvailable` reflects capability.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  webgpu = "available";
  loadShouldThrow = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("useResumeAnalysisLlm", () => {
  it("runs the combined pass and reaches done with both halves populated", async () => {
    const r = result();
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(r), sink);
    expect(sink.current!.isAvailable).toBe(true);
    await act(async () => {
      await sink.current!.run();
    });
    const status = sink.current!.status;
    expect(status.kind).toBe("done");
    if (status.kind !== "done") return;
    // The diff and critique both populate from the single inference.
    expect(status.disagreements).toBeDefined();
    expect(status.critique.bulletFindings).toHaveLength(2);
    // The #148 snapshot-before-await contract: the controller acquires the
    // inference slot for the selected model and releases the same id.
    expect(acquireInference).toHaveBeenCalledWith("test-model");
    expect(releaseInference).toHaveBeenCalledWith("test-model");
    // All three telemetry events fire from the single combined pass.
    expect(trackLlmParseRan).toHaveBeenCalledTimes(1);
    expect(trackDisagreementsFound).toHaveBeenCalledTimes(1);
    expect(trackCritiqueRan).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without WebGPU", async () => {
    webgpu = "unavailable";
    const r = result();
    const sink: { current: ReturnType<typeof useResumeAnalysisLlm> | null } = {
      current: null,
    };
    await mount(() => useResumeAnalysisLlm(r), sink);
    expect(sink.current!.isAvailable).toBe(false);
  });
});

describe("useLlmEscapeHatch", () => {
  it("runs and reaches done", async () => {
    const r = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    await mount(() => useLlmEscapeHatch(r), sink);
    expect(sink.current!.isAvailable).toBe(true);
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("done");
    // The #148 snapshot-before-await contract: the controller acquires the
    // inference slot for the selected model and releases the same id.
    expect(acquireInference).toHaveBeenCalledWith("test-model");
    expect(releaseInference).toHaveBeenCalledWith("test-model");
  });

  it("surfaces an error when the engine fails to load", async () => {
    loadShouldThrow = true;
    const r = result();
    const sink: { current: ReturnType<typeof useLlmEscapeHatch> | null } = {
      current: null,
    };
    await mount(() => useLlmEscapeHatch(r), sink);
    await act(async () => {
      await sink.current!.run();
    });
    expect(sink.current!.status.kind).toBe("error");
  });
});

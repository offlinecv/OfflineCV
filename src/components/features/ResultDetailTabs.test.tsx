// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for ResultDetailTabs (#275) — the tabbed detail card extracted
 * out of ParsedCard. Renders both visibility regimes so every conditional tab /
 * panel branch executes: (1) analysis unavailable → only reconstructed +
 * diagnostics tabs; (2) analysis available with a summary → the "What an ATS
 * misses" and "Resume quality" insight tabs both mount. A tiny host component
 * supplies a real EditableParse via useEditableParse. Raw createRoot, matching
 * the other feature render tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResultDetailTabs } from "./ResultDetailTabs.tsx";
import { useEditableParse } from "../../hooks/useEditableParse.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const EMPTY_CRITIQUE: ResumeCritique = { bulletFindings: [], missingSections: [] };

function result(summary?: string): CascadeResult {
  return {
    parsed: { skills: [], experience: [], education: [], ...(summary ? { summary } : {}) },
    confidence: 0.6,
    fieldConfidence: {},
    triggers: ["two_column"],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "RAWTEXT_MARKER",
    markdown: "RAWTEXT_MARKER",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 50, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

const score = { overall: 60, verdict: "Getting There" } as unknown as AnonymousAtsScore;

function controller(isAvailable: boolean): AnalysisController {
  return {
    status: { kind: "done", disagreements: [], critique: EMPTY_CRITIQUE },
    isAvailable,
    isBusy: false,
    run: () => Promise.resolve(),
  } as unknown as AnalysisController;
}

let container: HTMLDivElement;
let root: Root;

function Host({ isAvailable, summary }: { isAvailable: boolean; summary?: string }) {
  const edit = useEditableParse();
  const res = result(summary);
  return createElement(ResultDetailTabs, {
    activeResult: res,
    activeScore: score,
    result: res,
    sourceKind: "pdf",
    edit,
    analysis: controller(isAvailable),
    reportableDisagreements: undefined,
    triggerCount: res.triggers.length,
  });
}

function render(isAvailable: boolean, summary?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Host, { isAvailable, summary }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("ResultDetailTabs", () => {
  it("shows only reconstructed + diagnostics when analysis is unavailable", () => {
    const el = render(false);
    expect(el.textContent).toContain("Reconstructed resume");
    expect(el.textContent).toContain("Source & diagnostics");
    expect(el.textContent).not.toContain("What an ATS misses");
    expect(el.textContent).not.toContain("Resume quality");
  });

  it("mounts the insight tabs when analysis is available and a summary exists", () => {
    const el = render(true, "Senior engineer with a track record of shipping.");
    expect(el.textContent).toContain("What an ATS misses");
    expect(el.textContent).toContain("Resume quality");
  });
});

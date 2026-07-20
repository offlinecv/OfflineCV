// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for ResumeQualityPanel (#273) — the consolidated "Resume
 * Quality" tab shell. Covers the status lifecycle (loading/running/error/done)
 * and the done-branch variants: with gaps, without gaps, and with an empty
 * critique result (neutral note). Raw createRoot + act, matching the other
 * feature render tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResumeQualityPanel } from "./ResumeQualityPanel.tsx";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Minimal CascadeResult stub — only needs to be a valid reference for render;
// buildReproArtifact is only called on button click (not tested here).
const stubResult = {
  canonical: {
    fields: { skills: [], experience: [], education: [] },
    sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
    fieldConfidence: {},
  },
  confidence: 0,
  triggers: [],
  suggestedEscalation: "none",
  tiers: [],
  rawText: "",
  linkAnnotations: [],
  diagnostics: { pages: 1, elapsedMs: 0 },
} as unknown as CascadeResult;

const EMPTY_CRITIQUE: ResumeCritique = { bulletFindings: [], missingSections: [] };

const allKindsDisagreements: ParseDisagreement[] = [
  { kind: "dropped_role", field: "experience", heuristicValue: "1", llmValue: "3", likelyCause: "two_column" },
  { kind: "missing_field", field: "email", heuristicValue: null, llmValue: "jane@example.com" },
];

function controller(status: AnalysisController["status"]): AnalysisController {
  return {
    status,
    isAvailable: true,
    capability: "available",
    hasText: true,
    isBusy: false,
    run: () => Promise.resolve(),
  };
}

let container: HTMLDivElement;
let root: Root;

function render(status: AnalysisController["status"]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(ResumeQualityPanel, {
        controller: controller(status),
        result: stubResult,
        onGoToRewrite: () => {},
      }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("ResumeQualityPanel", () => {
  it("renders loading status with progress bar", () => {
    const el = render({ kind: "loading", progress: { progress: 0.4, text: "Fetching…" } });
    expect(el.textContent).toBeTruthy();
    // The CTA button should be present with the loading label.
    expect(el.textContent).toContain("Loading model");
  });

  it("renders running status", () => {
    const el = render({ kind: "running" });
    expect(el.textContent).toContain("Analyzing");
  });

  it("renders error status", () => {
    const el = render({ kind: "error", message: "WebGPU not supported" });
    expect(el.textContent).toContain("WebGPU not supported");
  });

  it("done WITH gaps — shows 'What an ATS misses' section and ReportGap trigger", () => {
    const el = render({
      kind: "done",
      disagreements: allKindsDisagreements,
      critique: EMPTY_CRITIQUE,
    });
    expect(el.textContent).toContain("What an ATS misses");
    expect(el.textContent).toContain("Report a parsing gap");
  });

  it("done WITHOUT gaps — does NOT show 'What an ATS misses'", () => {
    const el = render({
      kind: "done",
      disagreements: [],
      critique: EMPTY_CRITIQUE,
    });
    expect(el.textContent).not.toContain("What an ATS misses");
    expect(el.textContent).not.toContain("Report a parsing gap");
  });

  it("done with empty critique — shows neutral note, NOT overclaim", () => {
    const el = render({
      kind: "done",
      disagreements: [],
      critique: { bulletFindings: [{ bullet: "x", issue: "ok" }], missingSections: [] },
    });
    expect(el.textContent).toContain("No specific bullet issues or missing sections were flagged");
    expect(el.textContent).not.toContain("All bullets look strong");
  });

  it("threads onGoToRewrite end-to-end — 'Rewrite this section →' fires the callback (AC#3)", () => {
    let fired = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(ResumeQualityPanel, {
          controller: controller({
            kind: "done",
            disagreements: [],
            critique: {
              bulletFindings: [
                { bullet: "Was responsible for stuff", issue: "weak_verb", suggestion: "Led stuff" },
              ],
              missingSections: [],
            },
          }),
          result: stubResult,
          onGoToRewrite: () => {
            fired += 1;
          },
        }),
      );
    });
    const rewriteBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rewrite this section"),
    );
    expect(rewriteBtn).toBeTruthy();
    act(() => {
      rewriteBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fired).toBe(1);
  });
});

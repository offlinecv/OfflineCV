// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for CritiquePanel (#244) — display-only "Resume quality" tab.
 * Drives a fake unified analysis controller (#262) through each status so every
 * branch of CritiquePanel and CritiqueDonePanel (summary feedback, flagged
 * bullets, missing sections, all-ok) executes. Raw createRoot, matching the
 * other feature render tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CritiquePanel } from "./CritiquePanel.tsx";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function controller(status: AnalysisController["status"]): AnalysisController {
  return { status, isAvailable: true, isBusy: false, run: () => Promise.resolve() };
}

let container: HTMLDivElement;
let root: Root;

function render(status: AnalysisController["status"]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(CritiquePanel, { controller: controller(status), onGoToRewrite: () => {} }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("CritiquePanel", () => {
  it("renders flagged bullets, summary feedback, and missing sections", () => {
    const critique: ResumeCritique = {
      bulletFindings: [
        { bullet: "Was responsible for stuff", issue: "weak_verb", suggestion: "Led stuff" },
        { bullet: "Did things", issue: "vague" },
        { bullet: "Shipped X with metric", issue: "ok" },
      ],
      missingSections: ["skills"],
      summaryFeedback: "Tighten the summary.",
    };
    const el = render({ kind: "done", disagreements: [], critique });
    expect(el.textContent).toContain("Weak verb");
    expect(el.textContent).toContain("Suggestion:");
    expect(el.textContent).toContain("Tighten the summary");
    expect(el.textContent).toContain("Possibly missing sections");
    expect(el.textContent).toContain("skills");
  });

  it("renders the all-ok done state", () => {
    const el = render({
      kind: "done",
      disagreements: [],
      critique: { bulletFindings: [{ bullet: "x", issue: "ok" }], missingSections: [] },
    });
    expect(el.textContent).toContain("All bullets look strong");
  });

  it("renders loading, running, and error states", () => {
    expect(render({ kind: "loading", progress: { progress: 0.2, text: "…" } }).textContent).toBeTruthy();
    act(() => root.unmount());
    container.remove();
    expect(render({ kind: "running" }).textContent).toContain("Analyzing");
    act(() => root.unmount());
    container.remove();
    expect(render({ kind: "error", message: "nope" }).textContent).toContain("nope");
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for CritiqueResults (#244, #273) — body-only "Resume quality"
 * display component. Drives the component directly with a `critique` prop so
 * every render branch (summary feedback, flagged bullets, missing sections,
 * all-ok neutral note) executes. Raw createRoot, matching the other feature
 * render tests. Loading/running/error states moved to ResumeQualityPanel.test.tsx.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CritiqueResults } from "./CritiquePanel.tsx";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function render(critique: ResumeCritique) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(CritiqueResults, { critique, onGoToRewrite: () => {} }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("CritiqueResults", () => {
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
    const el = render(critique);
    expect(el.textContent).toContain("Weak verb");
    expect(el.textContent).toContain("Suggestion:");
    expect(el.textContent).toContain("Tighten the summary");
    expect(el.textContent).toContain("Possibly missing sections");
    expect(el.textContent).toContain("skills");
  });

  it("renders the all-ok neutral note (not the overclaim)", () => {
    const el = render({
      bulletFindings: [{ bullet: "x", issue: "ok" }],
      missingSections: [],
    });
    expect(el.textContent).toContain("No specific bullet issues or missing sections were flagged");
    expect(el.textContent).not.toContain("All bullets look strong");
  });

  it("renders summaryFeedback even when all-ok", () => {
    const el = render({
      bulletFindings: [],
      missingSections: [],
      summaryFeedback: "Overall decent summary.",
    });
    expect(el.textContent).toContain("Overall decent summary.");
    expect(el.textContent).toContain("No specific bullet issues");
    expect(el.textContent).not.toContain("All bullets look strong");
  });
});

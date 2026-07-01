// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for DisagreementResults (#242, #273) — body-only "What an ATS
 * misses" display component. Drives the component directly with a `disagreements`
 * prop so every render branch plus the per-kind copy builders (`headlineFor`,
 * `sideValues`) execute. Raw createRoot, matching the other feature render tests.
 * Loading/running/error/empty-state moved to ResumeQualityPanel.test.tsx.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DisagreementResults } from "./DisagreementPanel.tsx";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const allKinds: ParseDisagreement[] = [
  { kind: "dropped_role", field: "experience", heuristicValue: "2", llmValue: "4", likelyCause: "two_column" },
  { kind: "merged_roles", field: "experience", heuristicValue: "1", llmValue: "3" },
  { kind: "dropped_section", field: "skills", heuristicValue: null, llmValue: "5" },
  { kind: "missing_field", field: "email", heuristicValue: null, llmValue: "jane@example.com" },
];

let container: HTMLDivElement;
let root: Root;

function render(disagreements: readonly ParseDisagreement[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(DisagreementResults, { disagreements }));
  });
  return container;
}

beforeEach(() => {});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("DisagreementResults", () => {
  it("renders all kinds", () => {
    const el = render(allKinds);
    expect(el.textContent).toContain("An ATS likely drops");
    expect(el.textContent).toContain("An ATS likely merges");
    expect(el.textContent).toContain("section");
    expect(el.textContent).toContain("Likely cause");
    // sideValues pluralization + missing-field side.
    expect(el.textContent).toContain("role");
  });

  it("renders null for empty disagreements", () => {
    const el = render([]);
    // DisagreementResults returns null when empty — nothing in the container.
    expect(el.textContent).toBe("");
  });
});

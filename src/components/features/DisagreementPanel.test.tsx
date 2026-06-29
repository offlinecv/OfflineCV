// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for DisagreementPanel (#242) — the display-only "what an ATS
 * misses" surface. Drives a fake controller through each status so every render
 * branch plus the per-kind copy builders (`headlineFor`, `sideValues`) execute.
 * Raw createRoot, matching the other feature render tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DisagreementPanel } from "./DisagreementPanel.tsx";
import type { DisagreementController } from "../../hooks/useParseDisagreement.ts";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const allKinds: ParseDisagreement[] = [
  { kind: "dropped_role", field: "experience", heuristicValue: "2", llmValue: "4", likelyCause: "two_column" },
  { kind: "merged_roles", field: "experience", heuristicValue: "1", llmValue: "3" },
  { kind: "dropped_section", field: "skills", heuristicValue: null, llmValue: "5" },
  { kind: "missing_field", field: "email", heuristicValue: null, llmValue: "jane@example.com" },
];

function controller(status: DisagreementController["status"]): DisagreementController {
  return { status, isAvailable: true, isBusy: false, run: () => Promise.resolve() };
}

let container: HTMLDivElement;
let root: Root;

function render(status: DisagreementController["status"]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(DisagreementPanel, { controller: controller(status) }));
  });
  return container;
}

beforeEach(() => {});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("DisagreementPanel", () => {
  it("renders all kinds in the done state", () => {
    const el = render({ kind: "done", disagreements: allKinds });
    expect(el.textContent).toContain("An ATS likely drops");
    expect(el.textContent).toContain("An ATS likely merges");
    expect(el.textContent).toContain("section");
    expect(el.textContent).toContain("Likely cause");
    // sideValues pluralization + missing-field side.
    expect(el.textContent).toContain("role");
  });

  it("renders the empty done state", () => {
    const el = render({ kind: "done", disagreements: [] });
    expect(el.textContent).toContain("No gaps found");
  });

  it("renders loading, running, and error states", () => {
    expect(render({ kind: "loading", progress: { progress: 0.3, text: "…" } }).textContent).toBeTruthy();
    act(() => root.unmount());
    container.remove();
    expect(render({ kind: "running" }).textContent).toContain("Comparing");
    act(() => root.unmount());
    container.remove();
    expect(render({ kind: "error", message: "boom" }).textContent).toContain("boom");
  });
});

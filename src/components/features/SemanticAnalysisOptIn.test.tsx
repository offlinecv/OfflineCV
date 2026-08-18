// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * SemanticAnalysisOptIn (#204) — the opt-in control and its lifecycle line,
 * driven directly.
 *
 * The sibling `PasteJdPanel.semantic.test.tsx` proves the wiring end to end
 * through the real hook. This file drives the presentational component across
 * every `JdMatchStatus` × capability combination, including the ones the
 * controller cannot currently produce — `error` is public API on the hook's
 * union but unreachable from today's `PasteJdPanel` (a semantic run only ever
 * starts when a keyword floor already exists), so an integration test cannot
 * reach it and it would otherwise ship unrendered.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SemanticAnalysisOptIn } from "./SemanticAnalysisOptIn.tsx";
import type { JdMatchStatus } from "../../hooks/useJdMatch.ts";
import type { JdMatchResult } from "../../lib/jd-match";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const KEYWORD: JdMatchResult = {
  path: "keyword",
  coverage: {
    covered: [],
    missing: [],
    score: 0,
    weights: { skill: 1, noun: 0.5 },
  },
  terms: [],
  nounsDropped: 0,
};

const SEMANTIC: JdMatchResult = {
  path: "semantic",
  verdicts: [],
  summary: { met: 0, partial: 0, missing: 0, total: 0 },
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(
  status: JdMatchStatus,
  capability: WebGpuCapability | null,
  checked = true,
  onChange: (next: boolean) => void = vi.fn(),
): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  container = el;
  root = createRoot(el);
  act(() => {
    root?.render(
      <SemanticAnalysisOptIn
        checked={checked}
        onChange={onChange}
        status={status}
        capability={capability}
      />,
    );
  });
  return el;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("SemanticAnalysisOptIn control", () => {
  it("is a real checkbox with the label as its accessible name", () => {
    const el = render({ kind: "idle" }, null, false);
    const box = el.querySelector('input[type="checkbox"]');
    expect(box).toBeTruthy();
    expect((box as HTMLInputElement).checked).toBe(false);
    const label = el.querySelector(`label[for="${(box as HTMLInputElement).id}"]`);
    expect(label?.textContent).toContain("Analyze with on-device AI");
  });

  it("reports the next checked state to its owner rather than holding one", () => {
    const onChange = vi.fn();
    const el = render({ kind: "idle" }, null, false, onChange);
    act(() => (el.querySelector("input") as HTMLInputElement).click());
    expect(onChange).toHaveBeenCalledWith(true);
    // Still unchecked: the component is fully controlled, so there is exactly
    // one copy of the opt-in boolean and it isn't here.
    expect((el.querySelector("input") as HTMLInputElement).checked).toBe(false);
  });
});

describe("SemanticAnalysisOptIn status line", () => {
  it("renders no line at all while unticked, whatever the status says", () => {
    const el = render({ kind: "loading", progress: { progress: 0.5, text: "x" } }, "available", false);
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders no line for an empty JD", () => {
    const el = render({ kind: "idle" }, "available");
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("says it is checking while the capability probe is unresolved", () => {
    const el = render({ kind: "ready", result: KEYWORD }, null);
    expect(el.textContent).toContain("Checking whether this browser can run");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("explains an unavailable GPU without sounding like a failure", () => {
    for (const capability of ["no-webgpu", "unsupported-os"] as const) {
      const el = render({ kind: "ready", result: KEYWORD }, capability);
      expect(el.textContent).toContain("This browser can't run on-device analysis");
      expect(el.textContent).toContain("keyword coverage below is unaffected");
      expect(el.querySelector('[role="alert"]')).toBeNull();
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it("renders the shared ModelLoadProgress with the real progress values", () => {
    const el = render(
      { kind: "loading", progress: { progress: 0.37, text: "params_shard_5.bin" } },
      "available",
    );
    const bar = el.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("37");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("100");
    expect(el.textContent).toContain("params_shard_5.bin");
    expect(el.textContent).toContain("one-time download");
  });

  it("uses truthful running copy with no invented requirement count", () => {
    const el = render({ kind: "running" }, "available");
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "Reading this JD",
    );
    expect(el.textContent).not.toMatch(/\d+\s+of\s+\d+/);
  });

  it("says nothing extra once semantic verdicts are on screen", () => {
    const el = render({ kind: "ready", result: SEMANTIC }, "available");
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("notes a degrade to keyword without calling it an error", () => {
    const el = render({ kind: "ready", result: KEYWORD }, "available");
    expect(el.textContent).toContain("didn't return a verdict for this JD");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("never leaks the controller's raw error message", () => {
    const el = render(
      {
        kind: "error",
        message:
          "Failed to fetch dynamically imported module: /assets/run-llm-match-a1b2c3.js",
      },
      "available",
    );
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("On-device analysis couldn't start");
    expect(el.textContent).not.toContain("Failed to fetch");
    expect(el.textContent).not.toContain("/assets/");
  });
});

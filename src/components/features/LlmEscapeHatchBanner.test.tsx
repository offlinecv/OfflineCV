// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for LlmEscapeHatchBanner (#243) — the degenerate-case recovery
 * CTA. Drives a fake controller through each status so every render branch plus
 * the `ctaLabel` lookup executes, and asserts the done state fires `onRecovered`.
 * Raw createRoot, matching the other feature render tests.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LlmEscapeHatchBanner } from "./LlmEscapeHatchBanner.tsx";
import type { EscapeHatchController } from "../../hooks/useLlmEscapeHatch.ts";
import type { LlmParsedResume } from "../../lib/webllm/parse-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const llmParsed: LlmParsedResume = {
  full_name: "Recovered",
  email: null,
  phone: null,
  location: null,
  summary: null,
  skills: [],
  experience: [],
  education: [],
};

function controller(status: EscapeHatchController["status"]): EscapeHatchController {
  return { status, isAvailable: true, isBusy: false, run: () => Promise.resolve() };
}

let container: HTMLDivElement;
let root: Root;

function render(
  status: EscapeHatchController["status"],
  onRecovered: (p: LlmParsedResume) => void = () => {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(LlmEscapeHatchBanner, { controller: controller(status), onRecovered }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("LlmEscapeHatchBanner", () => {
  it("renders the idle CTA", () => {
    expect(render({ kind: "idle" }).textContent).toContain("Try a local AI pass");
  });

  it("keeps the idle headline free of overstated parser-failure claims (issue 281)", () => {
    // Regression guard: an earlier headline ("We couldn't read much of this
    // resume") was a false claim on the soft-confidence firing path — the
    // parser had actually recovered most fields, confidence just sat below
    // the canonical threshold (e.g. missing dates on some roles). The banner
    // must speak neutrally about the parse quality across every path that
    // fires the escape hatch. Assert on the visible text so a future rewrite
    // that reintroduces the failed phrasing is caught.
    const text = render({ kind: "idle" }).textContent ?? "";
    expect(text).not.toMatch(/couldn'?t read much/i);
    expect(text).not.toMatch(/couldn'?t read this resume/i);
    // Broader net: catch any future rewrite that attributes a *parser*
    // failure to the resume ("we couldn't read/parse this", "we failed to
    // read/parse it", "unable to read/parse …"), not just the two exact
    // prior phrasings above. The headline should describe parse quality, not
    // blame the parser.
    expect(text).not.toMatch(/\b(couldn'?t|could not|can'?t|cannot|unable to|failed to)\s+(read|parse)\b/i);
  });

  it("renders loading, running, and error states", () => {
    expect(render({ kind: "loading", progress: { progress: 0.4, text: "…" } }).textContent).toBeTruthy();
    act(() => root.unmount());
    container.remove();
    expect(render({ kind: "running" }).textContent).toContain("Parsing");
    act(() => root.unmount());
    container.remove();
    expect(render({ kind: "error", message: "fail" }).textContent).toContain("fail");
  });

  it("fires onRecovered when the pass completes", () => {
    const onRecovered = vi.fn();
    render({ kind: "done", llmParsed }, onRecovered);
    expect(onRecovered).toHaveBeenCalledWith(llmParsed);
  });
});

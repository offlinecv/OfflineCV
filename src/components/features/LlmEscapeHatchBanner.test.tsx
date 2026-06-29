// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

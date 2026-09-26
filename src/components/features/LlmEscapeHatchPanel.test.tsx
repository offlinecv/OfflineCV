// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for LlmEscapeHatchPanel (#243) — the degenerate-case recovery
 * CTA. Drives a fake controller through each status so every render branch plus
 * the `ctaLabel` lookup executes, and asserts the done state fires `onRecovered`.
 * Raw createRoot, matching the other feature render tests.
 *
 * #687: "fires onRecovered when the pass completes" below mounts a component
 * already `kind: "done"` — no `running → done` TRANSITION ever happens, so it
 * cannot tell a panel that stays mounted through `done` (the invariant three
 * docblocks assert) from one unmounted and remounted at `done` (a fresh
 * instance whose mount-time effect fires the callback just the same, so a
 * plain "onRecovered was called" assertion cannot tell them apart either —
 * verified by hand: a `React.Profiler` around the panel reports the same
 * `"update"` phase whichever happens, since the phase tracks the PROFILER's
 * own boundary, not a remounted descendant). The "without remounting" test
 * below instead drives a real transition on one root and compares the DOM
 * identity of the panel's own `contents`-display wrapper (see
 * `LlmEscapeHatchPanel.tsx`) before and after — the one node whose element
 * type never changes across `status.kind`, so a genuine update reuses it and
 * a remount (verified by temporarily adding `key={status.kind}` to the
 * `LlmEscapeHatchPanel` element below, which must turn this test red) creates
 * a fresh one.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LlmEscapeHatchPanel } from "./LlmEscapeHatchPanel.tsx";
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
      createElement(LlmEscapeHatchPanel, { controller: controller(status), onRecovered }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("LlmEscapeHatchPanel", () => {
  it("renders the idle CTA", () => {
    expect(render({ kind: "idle" }).textContent).toContain("Try a local AI pass");
  });

  it("keeps the idle CTA off the primary rung, below Fix It (#810)", () => {
    // Fix It is the score card's primary action below 60; a second filled
    // accent button on the same card read as an equally urgent next step.
    const btn = render({ kind: "idle" }).querySelector<HTMLButtonElement>(
      'button[aria-label="Run an on-device AI pass to recover the resume parse"]',
    );
    expect(btn).not.toBeNull();
    expect(btn!.className).not.toContain("bg-accent-primary");
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
    // `source` is absent on this ProgressUpdate — the shipped-model label falls
    // back to "Loading {name}" (no download-size / device-cache framing) — and
    // the 40% must come from the 0.4 fraction, not merely "some text present".
    const loading = render({
      kind: "loading",
      progress: { progress: 0.4, text: "…" },
    }).textContent;
    expect(loading).toContain("Loading Gemma 2 (2B)");
    expect(loading).toContain("40%");
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

  it("fires onRecovered on a running→done transition without remounting (#687)", () => {
    // Falsifiability check performed by hand while writing this test: adding
    // `key={status.kind}` to the `createElement(LlmEscapeHatchPanel, …)` call
    // below forces React to tear down the panel and mount a fresh instance at
    // the transition — `wrapperAfter` then fails the `toBe` below even though
    // `onRecovered` still fires from the fresh instance's mount-time effect.
    // That key is deliberately NOT part of the committed test.
    const onRecovered = vi.fn();
    const el = render({ kind: "running" }, onRecovered);
    const wrapperBefore = el.firstElementChild;
    expect(wrapperBefore?.className).toBe("contents");
    expect(onRecovered).not.toHaveBeenCalled();

    act(() => {
      root.render(
        createElement(LlmEscapeHatchPanel, {
          controller: controller({ kind: "done", llmParsed }),
          onRecovered,
        }),
      );
    });

    const wrapperAfter = el.firstElementChild;
    // The SAME `contents` wrapper node survives the transition — a remount
    // would replace it with a new (equal-looking, but distinct) element.
    expect(wrapperAfter).toBe(wrapperBefore);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledWith(llmParsed);
  });

  it("collapses to a confirmation row once the pass has completed", () => {
    // `done` hands the tab back to ResumeQualityPanel, so the offer must stop
    // occupying it — but the component stays MOUNTED (the effect above is what
    // reports the recovered parse upward), so it has to shrink itself rather
    // than be unmounted by the caller.
    const text = render({ kind: "done", llmParsed }).textContent ?? "";
    expect(text).toContain("Recovered with on-device AI");
    expect(text).toContain("Re-run AI recovery");
    // The offer's heading and explainer are gone — no second primary CTA
    // sitting above the quality panel's own.
    expect(text).not.toContain("Not everything parsed cleanly");
    expect(text).not.toContain("One-time");
  });
});

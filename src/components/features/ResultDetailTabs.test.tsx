// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for ResultDetailTabs (#275, consolidated in #273) — the
 * tabbed detail card extracted out of ParsedCard. Renders both visibility
 * regimes so every conditional tab / panel branch executes: (1) analysis
 * unavailable → only reconstructed + diagnostics tabs; (2) analysis available →
 * the single "Resume Quality" insight tab mounts (2nd position). A tiny host
 * component supplies a real EditableParse via useEditableParse. Raw createRoot,
 * matching the other feature render tests.
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
import type { EscapeHatchController } from "../../hooks/useLlmEscapeHatch.ts";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";
import type { ResumeCritique } from "../../lib/webllm/critique-resume.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const EMPTY_CRITIQUE: ResumeCritique = { bulletFindings: [], missingSections: [] };

function result(summary?: string, title?: string): CascadeResult {
  return {
    canonical: {
      fields: {
        skills: [],
        experience: title ? [{ title }] : [],
        education: [],
        ...(summary ? { summary } : {}),
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 0.6,
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

interface ControllerOpts {
  isAvailable: boolean;
  capability?: WebGpuCapability | null;
  hasText?: boolean;
  /** Degenerate-parse recovery offer (#243) — folded into this tab. */
  escapeHatch?: "offered" | "recovered";
}

function escapeHatchController(
  opts: ControllerOpts,
): EscapeHatchController {
  return {
    status:
      opts.escapeHatch === "recovered"
        ? { kind: "done", llmParsed: {} }
        : { kind: "idle" },
    isAvailable: opts.escapeHatch !== undefined,
    isBusy: false,
    run: () => Promise.resolve(),
  } as unknown as EscapeHatchController;
}

function controller(opts: ControllerOpts): AnalysisController {
  return {
    status: { kind: "done", disagreements: [], critique: EMPTY_CRITIQUE },
    isAvailable: opts.isAvailable,
    // Default to the coherent pairing (available ⇒ has GPU + text) unless a
    // test overrides to exercise the unavailable-with-notice branch.
    capability: opts.capability ?? (opts.isAvailable ? "available" : null),
    hasText: opts.hasText ?? opts.isAvailable,
    isBusy: false,
    run: () => Promise.resolve(),
  } as unknown as AnalysisController;
}

let container: HTMLDivElement;
let root: Root;

function Host({ opts, summary }: { opts: ControllerOpts; summary?: string }) {
  const edit = useEditableParse();
  const res = result(summary);
  return createElement(ResultDetailTabs, {
    activeResult: res,
    activeScore: score,
    result: res,
    sourceKind: "pdf",
    edit,
    analysis: controller(opts),
    escapeHatch: escapeHatchController(opts),
    onRecovered: () => {},
    triggerCount: res.triggers.length,
  });
}

function render(opts: ControllerOpts, summary?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Host, { opts, summary }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("ResultDetailTabs", () => {
  it("hides the on-device-AI tab while capability is still detecting / no text", () => {
    const el = render({ isAvailable: false });
    expect(el.textContent).toContain("Your resume");
    expect(el.textContent).toContain("Find jobs");
    expect(el.textContent).toContain("Raw text & flags");
    expect(el.textContent).not.toContain("Local AI feedback");
  });

  it("mounts the single on-device-AI tab (3rd position) when analysis is available", () => {
    const el = render(
      { isAvailable: true },
      "Senior engineer with a track record of shipping.",
    );
    const labels = Array.from(el.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    // Exactly four tabs: reconstructed, Find jobs (#318, always present),
    // "Local AI feedback", diagnostics last.
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Your resume");
    expect(labels[1]).toContain("Find jobs");
    expect(labels[2]).toContain("Local AI feedback");
    expect(labels[3]).toContain("Raw text & flags");
    // No recovery offer, so no warn mark on this tab.
    expect(labels[2]).not.toContain("parse needs attention");
  });

  it("turns the on-device-AI tab into the recovery offer when the escape hatch is available", () => {
    // The banner used to render above the score card; the tab label is now the
    // whole pre-click signal, so it has to carry both the offer and the warning
    // (and the warning has to say what it means, not "setup needed").
    const el = render(
      { isAvailable: true, escapeHatch: "offered" },
      "Senior engineer with a track record of shipping.",
    );
    const qualityTab = Array.from(el.querySelectorAll('[role="tab"]')).find((t) =>
      (t.textContent ?? "").includes("local AI pass"),
    );
    expect(qualityTab).toBeDefined();
    expect(qualityTab?.textContent).toContain("didn't parse cleanly");
    expect(qualityTab?.textContent).toContain("parse needs attention");
    expect(qualityTab?.textContent).not.toContain("setup needed");
    // The offer owns the tab body alone — the quality panel's own CTA must not
    // sit under it, or the tab carries two model-loading CTAs at once.
    expect(el.textContent).toContain("Not everything parsed cleanly");
    expect(el.textContent).not.toContain("Analyze with on-device model");
  });

  it("drops the recovery label once the pass has run, keeping the banner", () => {
    // The hatch stays `isAvailable` after a successful pass (it is keyed on the
    // ORIGINAL result so it can be re-run), so without the status gate the tab
    // would keep inviting a pass the user already took.
    const el = render(
      { isAvailable: true, escapeHatch: "recovered" },
      "Senior engineer with a track record of shipping.",
    );
    const labels = Array.from(el.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(labels[2]).toContain("Local AI feedback");
    expect(labels[2]).not.toContain("local AI pass");
    expect(labels[2]).not.toContain("parse needs attention");
    // Collapsed confirmation + the quality panel it handed the tab back to.
    // Assert the PANEL's own heading, not the tab label: those were the same
    // string until the heading was renamed, so this line passed off `labels[2]`
    // above and never proved the panel had mounted at all.
    expect(el.textContent).toContain("Recovered with on-device AI");
    expect(el.textContent).toContain("What the model checks");
  });

  it("reseeds the Find jobs query when the LLM escape hatch swaps activeResult (keyed remount)", () => {
    // Original heuristic parse and a distinct recovered parse — same `result`
    // (the pre-LLM cascade), different `activeResult` once recovery lands. The
    // Find jobs panel seeds its query once from the parse; without the parse-
    // identity key it would keep the heuristic title while runSearch ranks the
    // recovered parse (PR #337 review). Keyed remount reseeds it.
    const heuristic = result(undefined, "Heuristic Engineer");
    const recovered = result(undefined, "Recovered Architect");
    const opts: ControllerOpts = { isAvailable: false };

    function RecoveryHost({ recover }: { recover: boolean }) {
      const edit = useEditableParse();
      return createElement(ResultDetailTabs, {
        activeResult: recover ? recovered : heuristic,
        activeScore: score,
        result: heuristic,
        sourceKind: "pdf",
        edit,
        analysis: controller(opts),
        escapeHatch: escapeHatchController(opts),
        onRecovered: () => {},
        triggerCount: heuristic.triggers.length,
      });
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(RecoveryHost, { recover: false }));
    });
    expect(container.textContent).toContain("Heuristic Engineer");

    // Escape hatch recovers a better parse: activeResult now !== result.
    act(() => {
      root.render(createElement(RecoveryHost, { recover: true }));
    });
    expect(container.textContent).toContain("Recovered Architect");
    expect(container.textContent).not.toContain("Heuristic Engineer");
  });

  it("keeps the on-device-AI tab (warn-marked) with the notice when WebGPU is unavailable", () => {
    const el = render(
      { isAvailable: false, capability: "no-webgpu", hasText: true },
      "Senior engineer with a track record of shipping.",
    );
    const qualityTab = Array.from(el.querySelectorAll('[role="tab"]')).find((t) =>
      (t.textContent ?? "").includes("Local AI feedback"),
    );
    expect(qualityTab).toBeDefined();
    // Warn marker is announced, not colour-only.
    expect(qualityTab?.textContent).toContain("setup needed");
    // The panel explains the unavailability in place instead of vanishing.
    expect(el.textContent).toContain("On-device AI isn't available");
  });
});

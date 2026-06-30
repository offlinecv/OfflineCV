// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for SourceDiagnosticsPanel (#263) — the segmented control that
 * collapses the three evidence views (PDF / Extracted text / Layout flags) under
 * one primary tab. Drives the segment switch and asserts: PDF is the default
 * segment, the Layout-flags count badge reflects trigger count, switching toggles
 * `aria-pressed`, and all three panels stay mounted (hidden, not unmounted) so the
 * PDF preview is never re-rasterized. Raw createRoot, matching the sibling panel
 * tests. sourceKind="docx" keeps pdfjs out of jsdom (the no-preview fallback).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SourceDiagnosticsPanel } from "./SourceDiagnosticsPanel.tsx";
import type { CascadeResult } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function result(): CascadeResult {
  return {
    parsed: { skills: [], experience: [], education: [] },
    confidence: 0.6,
    fieldConfidence: {},
    triggers: ["two_column", "fonts_unmappable"],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "RAWTEXT_MARKER",
    markdown: "RAWTEXT_MARKER",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 50, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  } as unknown as CascadeResult;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(SourceDiagnosticsPanel, {
        result: result(),
        sourceKind: "docx",
      }),
    );
  });
  return container;
}

function segment(label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith(label),
  );
  if (btn == null) throw new Error(`segment button "${label}" not found`);
  return btn as HTMLButtonElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("SourceDiagnosticsPanel", () => {
  it("defaults to the PDF segment", () => {
    render();
    expect(segment("PDF").getAttribute("aria-pressed")).toBe("true");
    expect(segment("Extracted text").getAttribute("aria-pressed")).toBe("false");
    // The docx no-preview fallback (PDF panel) is the visible body.
    expect(container.textContent).toContain("No source preview available for DOCX");
  });

  it("shows the trigger count badge on the Layout flags segment", () => {
    render();
    // Two triggers → badge "2" inside the Layout flags segment button.
    expect(segment("Layout flags").textContent).toContain("2");
  });

  it("switches segments via aria-pressed and reveals extracted text", () => {
    render();
    act(() => {
      segment("Extracted text").click();
    });
    expect(segment("Extracted text").getAttribute("aria-pressed")).toBe("true");
    expect(segment("PDF").getAttribute("aria-pressed")).toBe("false");
    // rawText body is shown (its wrapper is no longer hidden).
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("RAWTEXT_MARKER");
    expect(pre?.closest("[hidden]")).toBeNull();
  });

  it("keeps all three panels mounted (hidden, not unmounted) across switches", () => {
    render();
    // PDF body present at first.
    const pdfText = "No source preview available for DOCX";
    expect(container.textContent).toContain(pdfText);
    act(() => {
      segment("Layout flags").click();
    });
    // PDF body is still in the DOM (mounted) — just inside a hidden wrapper.
    expect(container.textContent).toContain(pdfText);
    const pdfPara = Array.from(container.querySelectorAll("p")).find((p) =>
      p.textContent?.includes(pdfText),
    );
    expect(pdfPara?.closest("[hidden]")).not.toBeNull();
  });
});

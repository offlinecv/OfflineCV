// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for the ReportGapSection inside FeedbackPanel (#245). The
 * existing FeedbackPanel test mounts the panel with no `result`, so the gap
 * affordance renders nothing there; this file passes a `result` so the section
 * mounts and exercises its branches: collapsed trigger → expand → local download
 * → "downloaded" confirmation, plus the characterized-gap count line.
 *
 * Analytics is mocked DISABLED so the rating form returns null and this test
 * isolates ReportGapSection. The download is intercepted (Blob/anchor/object
 * URL) exactly as in useReportGap.test, and any network call fails the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { SectionedResume } from "../../lib/heuristics/sections.ts";
import type { SectionName } from "../../lib/heuristics/regex.ts";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";

vi.mock("../../lib/analytics.ts", () => ({
  ANALYTICS_ENABLED: false,
  trackFeedback: vi.fn(),
  trackGapReported: vi.fn(),
}));

import { FeedbackPanel } from "./FeedbackPanel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function sectioned(): SectionedResume {
  const byName = new Map<SectionName | "profile", readonly string[]>([
    ["experience", ["a bullet"]],
  ]);
  return { byName, accomplishmentSections: ["experience"], source: "regex" };
}

function result(): CascadeResult {
  return {
    parsed: {
      full_name: "Jane",
      email: "jane@example.com",
      skills: ["s"],
      experience: [{ company: "Co", title: "T", description: "d", is_current: false }],
      education: [],
    },
    confidence: 0.6,
    fieldConfidence: {},
    triggers: ["two_column"],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "text",
    markdown: "text",
    sections: sectioned(),
    linkAnnotations: [],
    diagnostics: { rawCharCount: 100, extractedCharCount: 50, pages: 1, elapsedMs: 10 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

const disagreements: ParseDisagreement[] = [
  { kind: "merged_roles", field: "experience", heuristicValue: "1", llmValue: "3", likelyCause: "two_column" },
];

let container: HTMLDivElement;
let root: Root;
let anchorClicked = false;

beforeEach(() => {
  anchorClicked = false;
  const RealBlob = globalThis.Blob;
  vi.spyOn(globalThis, "Blob").mockImplementation(
    (parts?: BlobPart[], opts?: BlobPropertyBag) => new RealBlob(parts, opts),
  );
  globalThis.URL.createObjectURL = vi.fn(
    () => "blob:mock",
  ) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchorClicked = true;
  });
  globalThis.fetch = vi.fn(() => {
    throw new Error("ReportGapSection must not make a network request");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<FeedbackPanel result={result()} disagreements={disagreements} />);
  });
}

function clickButton(label: RegExp) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!btn) throw new Error(`button not found: ${label}`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ReportGapSection", () => {
  it("expands, downloads locally, and confirms — no network call", async () => {
    mount();
    // Collapsed trigger present.
    expect(container.textContent).toContain("Report a parsing gap");

    clickButton(/Report a parsing gap/);
    // Expanded: explainer + characterized-gap count line.
    expect(container.textContent).toContain("structure-only");
    expect(container.textContent).toContain("characterized gap");

    clickButton(/Download diagnostic file/);
    await act(async () => {
      await Promise.resolve();
    });

    expect(anchorClicked).toBe(true);
    expect(container.textContent).toContain("Diagnostic file downloaded");
  });
});

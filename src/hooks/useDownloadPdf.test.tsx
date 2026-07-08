// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * useDownloadPdf behaviour (#313 additions), exercised through a probe
 * component (the project has no @testing-library/react — same pattern as the
 * other hook tests, e.g. `useReportGap.test.tsx`).
 *
 * Covers: a download tags the analytics event with `source: "blank"` when
 * the result came from `buildBlankResult()` (`tiers: []`) vs `source:
 * "upload"` for any real parse; and a successful blank-authored download
 * clears the persisted draft key (#313 AC — "cleared … on successful export").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDownloadPdf, type UseDownloadPdf } from "./useDownloadPdf.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { computeAnonymousAtsScore } from "../lib/score/score.ts";
import { BLANK_DRAFT_STORAGE_KEY } from "./useResumeAnalysis.ts";
import { installMemoryLocalStorage } from "./__test-utils__/memory-storage.ts";

const tracked: Array<{ source: string }> = [];
vi.mock("../lib/analytics.ts", () => ({
  trackDownloadCompleted: (args: { source: string }) => tracked.push(args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function uploadedResult(): CascadeResult {
  return {
    parsed: {
      full_name: "Jane Doe",
      email: "jane@example.com",
      skills: [],
      experience: [
        { company: "Acme", title: "Engineer", description: "Did work" },
      ],
      education: [],
    },
    confidence: 0.8,
    fieldConfidence: {},
    triggers: [],
    suggestedEscalation: "none",
    // Non-empty tiers — a real (uploaded) parse always has at least these.
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Jane Doe\njane@example.com\nEngineer at Acme\nDid work",
    sections: {
      byName: new Map(),
      accomplishmentSections: ["experience"],
      source: "regex",
    },
    linkAnnotations: [],
    diagnostics: { rawCharCount: 10, extractedCharCount: 10, pages: 1, elapsedMs: 1 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

let container: HTMLDivElement;
let root: Root;
let api: UseDownloadPdf;

function Probe({ result }: { result: CascadeResult }) {
  const score = computeAnonymousAtsScore({
    parsed: result.parsed,
    fieldConfidence: result.fieldConfidence,
    triggers: result.triggers,
    rawText: result.rawText,
    sections: result.sections,
  });
  api = useDownloadPdf(result, score);
  return null;
}

function mount(result: CascadeResult): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe result={result} />));
}

beforeEach(() => {
  tracked.length = 0;
  installMemoryLocalStorage();

  globalThis.URL.createObjectURL = vi.fn(
    () => "blob:mock",
  ) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      // no-op — jsdom would otherwise try to navigate
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("useDownloadPdf — download-source tagging (#313)", () => {
  it("tags an uploaded (non-blank) result's download as source: 'upload'", async () => {
    mount(uploadedResult());
    await act(async () => {
      await api.download();
    });

    expect(tracked).toEqual([{ source: "upload" }]);
  });

  it("tags a blank/authored result's download as source: 'blank'", async () => {
    mount(buildBlankResult());
    await act(async () => {
      await api.download();
    });

    expect(tracked).toEqual([{ source: "blank" }]);
  });

  it("clears the persisted blank draft on a successful blank-authored download", async () => {
    localStorage.setItem(BLANK_DRAFT_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    mount(buildBlankResult());

    await act(async () => {
      await api.download();
    });

    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("does not touch the blank draft key on an uploaded download", async () => {
    localStorage.setItem(BLANK_DRAFT_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    mount(uploadedResult());

    await act(async () => {
      await api.download();
    });

    expect(localStorage.getItem(BLANK_DRAFT_STORAGE_KEY)).not.toBeNull();
  });
});

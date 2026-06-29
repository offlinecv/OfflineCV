// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * useReportGap behaviour (#245), exercised through a probe component (the
 * project has no @testing-library/react — same pattern as the other hook tests).
 *
 * Covers: report() triggers a LOCAL download (anchor click, object URL) and
 * NEVER a network upload; the count-only telemetry carries only a count + the
 * trigger enum (no résumé text); and the downloaded Blob content is PII-free.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useReportGap, type UseReportGap } from "./useReportGap.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { SectionName } from "../lib/heuristics/regex.ts";
import type { ParseDisagreement } from "../lib/heuristics/disagreement.ts";

// Capture telemetry without a PostHog stub.
const tracked: Array<{ disagreementCount: number; triggers: readonly string[] }> =
  [];
vi.mock("../lib/analytics.ts", () => ({
  trackGapReported: (args: {
    disagreementCount: number;
    triggers: readonly string[];
  }) => tracked.push(args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PII_SENTINEL = "SENTINEL_PII_jane@leak.invalid";

function result(): CascadeResult {
  const byName = new Map<SectionName | "profile", readonly string[]>([
    ["experience", [PII_SENTINEL, PII_SENTINEL]],
  ]);
  const sections: SectionedResume = {
    byName,
    accomplishmentSections: ["experience"],
    source: "regex",
  };
  return {
    parsed: {
      full_name: PII_SENTINEL,
      email: PII_SENTINEL,
      skills: [PII_SENTINEL],
      experience: [
        { company: PII_SENTINEL, title: PII_SENTINEL, description: PII_SENTINEL },
      ],
      education: [],
    },
    confidence: 0.6,
    fieldConfidence: {},
    triggers: ["two_column"],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: PII_SENTINEL,
    markdown: PII_SENTINEL,
    sections,
    linkAnnotations: [],
    diagnostics: {
      rawCharCount: 100,
      extractedCharCount: 50,
      pages: 1,
      elapsedMs: 10,
    },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

const disagreements: ParseDisagreement[] = [
  {
    kind: "merged_roles",
    field: "experience",
    heuristicValue: PII_SENTINEL,
    llmValue: PII_SENTINEL,
    likelyCause: "two_column",
  },
];

let container: HTMLDivElement;
let root: Root;
let api: UseReportGap;
let downloadedBlobText = "";
let anchorClicked = false;
let fetchSpy: ReturnType<typeof vi.fn>;

function Probe({ withGaps }: { withGaps: boolean }) {
  api = useReportGap(result(), withGaps ? disagreements : []);
  return null;
}

beforeEach(() => {
  tracked.length = 0;
  downloadedBlobText = "";
  anchorClicked = false;
  container = document.createElement("div");
  document.body.appendChild(container);

  // Capture the JSON the hook serializes by spying on the Blob constructor —
  // jsdom's Blob has no async .text(), so read the constructor parts directly.
  const RealBlob = globalThis.Blob;
  vi.spyOn(globalThis, "Blob").mockImplementation(
    (parts?: BlobPart[], opts?: BlobPropertyBag) => {
      if (parts && typeof parts[0] === "string") downloadedBlobText = parts[0];
      return new RealBlob(parts, opts);
    },
  );
  globalThis.URL.createObjectURL = vi.fn(
    () => "blob:mock",
  ) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();

  // Intercept the anchor click so jsdom doesn't try to navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchorClicked = true;
  });

  // Any network call would be a violation — fail loudly if one happens.
  fetchSpy = vi.fn(() => {
    throw new Error("useReportGap must not make a network request");
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useReportGap", () => {
  it("downloads locally, makes no network call, and tracks count-only", async () => {
    root = createRoot(container);
    act(() => {
      root.render(<Probe withGaps={true} />);
    });

    act(() => {
      api.report();
    });
    // Let the Blob.text() microtask settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.error).toBeNull();
    expect(anchorClicked).toBe(true);
    expect(api.reported).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Telemetry is count-only: a disagreement count + the trigger enum, no text.
    expect(tracked).toHaveLength(1);
    expect(tracked[0].disagreementCount).toBe(1);
    expect(tracked[0].triggers).toEqual(["two_column"]);
    expect(JSON.stringify(tracked[0])).not.toContain(PII_SENTINEL);

    // The downloaded artifact carries no PII.
    expect(downloadedBlobText.length).toBeGreaterThan(0);
    expect(downloadedBlobText).not.toContain(PII_SENTINEL);
  });

  it("reports zero gaps when the WebLLM comparison was not run", async () => {
    root = createRoot(container);
    act(() => {
      root.render(<Probe withGaps={false} />);
    });
    act(() => {
      api.report();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(tracked[0].disagreementCount).toBe(0);
    expect(downloadedBlobText).not.toContain(PII_SENTINEL);
  });
});

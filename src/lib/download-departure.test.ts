// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `departToDownload` / `departToDownloadAndNavigate` — the single definition
 * of "leave `/` for `/download/`", mirroring `jobs-departure.test.ts`.
 *
 * The defect this guards: a route that navigates but hands nothing over, so
 * `/download/` renders with no résumé to export at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  departToDownload,
  departToDownloadAndNavigate,
} from "./download-departure.ts";
import { readDownloadHandoff } from "./download-handoff.ts";
import { readDepartureMarker } from "./nav-return.ts";
import type { DownloadHandoff } from "./download-handoff.ts";
import type { CascadeResult } from "./heuristics/types.ts";
import { installMemorySessionStorage } from "../hooks/__test-utils__/memory-storage.ts";

function fakeHandoff(): DownloadHandoff {
  const result: CascadeResult = {
    canonical: {
      fields: {
        full_name: "Dana Fixture",
        skills: ["React"],
        experience: [],
        education: [],
      },
      sections: {
        byName: new Map(),
        accomplishmentSections: ["experience"],
        source: "regex",
      },
      fieldConfidence: {},
    },
    confidence: 0.9,
    triggers: [],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "Dana Fixture",
    linkAnnotations: [],
    diagnostics: { rawCharCount: 10, extractedCharCount: 10, pages: 1, elapsedMs: 1 },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
  return {
    result,
    score: {
      overall: 70,
      preLayoutOverall: 70,
      specificity: { score: 28, max: 40, gradable: true, metricBullets: 0, totalBullets: 0 },
      structure: {
        score: 21,
        max: 30,
        gradable: true,
        goodBullets: 0,
        verbLedBullets: 0,
        inWindowBullets: 0,
        totalBullets: 0,
      },
      completeness: { score: 21, max: 30, gradable: true, missing: [] },
      layout: { triggers: [], multiplier: 1, scanned: false },
    },
    contactOverrides: {},
  };
}

beforeEach(() => {
  // A fresh in-memory shim, not the runtime's global: on Node 22+ that global
  // is not jsdom's `Storage`, so the throwing-write spies below would miss it.
  installMemorySessionStorage();
});

describe("departToDownload", () => {
  it("writes the handoff AND marks the departure", () => {
    departToDownload(fakeHandoff());
    expect(readDownloadHandoff()?.result.canonical.fields.full_name).toBe(
      "Dana Fixture",
    );
    expect(readDepartureMarker()).toBe(true);
  });

  it("hands the journey-ledger key over with the résumé (#826)", () => {
    departToDownload({ ...fakeHandoff(), journeyKey: "a1b2c3d4" });
    expect(readDownloadHandoff()?.journeyKey).toBe("a1b2c3d4");
  });
});

describe("departToDownloadAndNavigate", () => {
  it("writes the handoff, marks the departure, then navigates to /download/", () => {
    const assign = vi.fn();
    departToDownloadAndNavigate(fakeHandoff(), { assign });
    expect(readDownloadHandoff()).not.toBeNull();
    expect(readDepartureMarker()).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]?.[0]).toBe(
      `${import.meta.env.BASE_URL}download/`,
    );
  });

  it("navigates only after the handoff is written", () => {
    // A navigation whose write failed should never fire — asserting ORDER
    // rather than just "both happened" is what catches a refactor that
    // reorders the two statements.
    const order: string[] = [];
    const assign = vi.fn(() => {
      order.push("navigate");
    });
    const real = sessionStorage.setItem.bind(sessionStorage);
    const setItem = vi
      .spyOn(sessionStorage, "setItem")
      .mockImplementation((key, value) => {
        order.push("write");
        real(key, value);
      });
    try {
      departToDownloadAndNavigate(fakeHandoff(), { assign });
    } finally {
      setItem.mockRestore();
    }
    expect(order).toEqual(["write", "write", "navigate"]);
  });

  it("does not navigate when a replacement write fails, and does not leave the earlier résumé behind", () => {
    // The defect this guards: an earlier résumé was stored, this departure's
    // replacement write fails (quota / private-mode), and navigating anyway
    // would send `/download/` to read back the STALE earlier handoff instead
    // of the one the user just tried to send — wrong, not merely absent.
    departToDownload(fakeHandoff());
    expect(readDownloadHandoff()).not.toBeNull();

    const setItem = vi
      .spyOn(sessionStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    const assign = vi.fn();
    try {
      departToDownloadAndNavigate(fakeHandoff(), { assign });
    } finally {
      setItem.mockRestore();
    }
    expect(assign).not.toHaveBeenCalled();
    expect(readDownloadHandoff()).toBeNull();
  });

  it("does not mark the departure when the handoff write fails", () => {
    // The defect this guards: `departToDownload` marked the departure
    // unconditionally, so a failed write (quota / private-mode) that never
    // navigates still left a marker behind for a later, unrelated visit to
    // misread as a genuine round trip from `/`.
    const setItem = vi
      .spyOn(sessionStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    const assign = vi.fn();
    try {
      departToDownloadAndNavigate(fakeHandoff(), { assign });
    } finally {
      setItem.mockRestore();
    }
    expect(assign).not.toHaveBeenCalled();
    expect(readDepartureMarker()).toBe(false);
  });
});

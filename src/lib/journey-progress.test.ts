// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The journey completion ledger (#826).
 *
 * Three properties matter, and each one is a way the ✓ mark becomes a lie
 * rather than a fact: it must survive a reload (a fresh read is what the next
 * session sees — this module caches nothing), it must stay bounded, and it must
 * never bleed between résumés. The fourth is the failure direction: unusable
 * storage costs a checkmark and nothing else, so every degraded path reads as
 * "nothing completed" and no path throws.
 *
 * The `localStorage` shim is installed globally before every test by
 * `src/test-setup.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  JOURNEY_PROGRESS_KEY,
  JOURNEY_PROGRESS_MAX_RESUMES,
  completionOf,
  markJourneyMilestone,
  parseLedger,
  readJourneyProgress,
  withMilestone,
} from "./journey-progress.ts";

describe("journey-progress — what the ✓ mark is allowed to claim", () => {
  it("claims nothing for a résumé that has done nothing", () => {
    expect(readJourneyProgress("a1b2c3d4")).toEqual({});
  });

  it("remembers a milestone across a fresh read — the reload case", () => {
    markJourneyMilestone("a1b2c3d4", "download");
    expect(readJourneyProgress("a1b2c3d4")).toEqual({ download: true });
  });

  it("accumulates milestones rather than replacing them", () => {
    markJourneyMilestone("a1b2c3d4", "download");
    markJourneyMilestone("a1b2c3d4", "match");
    expect(readJourneyProgress("a1b2c3d4")).toEqual({
      download: true,
      match: true,
    });
  });

  it("keeps one résumé's marks off another's", () => {
    // The whole point of keying per résumé: exporting A must leave B's
    // Download unchecked.
    markJourneyMilestone("aaaaaaaa", "download");
    expect(readJourneyProgress("bbbbbbbb")).toEqual({});
  });

  it("reports a repeat mark as no change, so nothing re-renders for it", () => {
    expect(markJourneyMilestone("a1b2c3d4", "fix")).toBe(true);
    expect(markJourneyMilestone("a1b2c3d4", "fix")).toBe(false);
  });

  it("reads a null key — nothing parsed — as nothing completed", () => {
    markJourneyMilestone("a1b2c3d4", "fix");
    expect(readJourneyProgress(null)).toEqual({});
  });
});

describe("journey-progress — bounded", () => {
  it(`keeps at most ${JOURNEY_PROGRESS_MAX_RESUMES} résumés, evicting the oldest write`, () => {
    for (let i = 0; i <= JOURNEY_PROGRESS_MAX_RESUMES; i++) {
      markJourneyMilestone(`resume-${i}`, "download");
    }
    // `resume-0` was written first and is one over the cap, so it is gone;
    // everything after it survives.
    expect(readJourneyProgress("resume-0")).toEqual({});
    expect(readJourneyProgress("resume-1")).toEqual({ download: true });
    expect(
      readJourneyProgress(`resume-${JOURNEY_PROGRESS_MAX_RESUMES}`),
    ).toEqual({ download: true });
  });

  it("counts recency by WRITE, not by first appearance", () => {
    // A résumé the user keeps coming back to must not be evicted ahead of one
    // they touched once and abandoned.
    markJourneyMilestone("old", "download");
    for (let i = 1; i < JOURNEY_PROGRESS_MAX_RESUMES; i++) {
      markJourneyMilestone(`filler-${i}`, "download");
    }
    markJourneyMilestone("old", "match");
    markJourneyMilestone("newcomer", "download");

    expect(readJourneyProgress("old")).toEqual({
      download: true,
      match: true,
    });
    expect(readJourneyProgress("filler-1")).toEqual({});
  });

  it("does not reorder an all-digit key ahead of the rest", () => {
    // `fingerprintParse` returns 8 hex chars, so an all-digit key is a legal
    // output — and an array-index-like property name a plain object would
    // hoist to the front, silently evicting the wrong entry.
    markJourneyMilestone("12345678", "download");
    markJourneyMilestone("ffffffff", "match");
    const stored = parseLedger(localStorage.getItem(JOURNEY_PROGRESS_KEY));
    expect(stored.map((e) => e.key)).toEqual(["12345678", "ffffffff"]);
  });
});

describe("journey-progress — a degraded store costs a checkmark and nothing else", () => {
  it("reads a corrupt value as nothing completed", () => {
    localStorage.setItem(JOURNEY_PROGRESS_KEY, "{not json");
    expect(readJourneyProgress("a1b2c3d4")).toEqual({});
  });

  it("drops malformed entries but keeps the readable ones", () => {
    localStorage.setItem(
      JOURNEY_PROGRESS_KEY,
      JSON.stringify([
        null,
        { key: "", done: ["fix"] },
        { key: "a1b2c3d4", done: ["download", "not-a-stage", 42] },
        { key: "bbbbbbbb" },
      ]),
    );
    expect(readJourneyProgress("a1b2c3d4")).toEqual({ download: true });
    expect(readJourneyProgress("bbbbbbbb")).toEqual({});
  });

  it("does not throw when the store refuses a read", () => {
    const getItem = vi
      .spyOn(globalThis.localStorage, "getItem")
      .mockImplementation(() => {
        throw new DOMException("SecurityError");
      });
    expect(() => readJourneyProgress("a1b2c3d4")).not.toThrow();
    expect(readJourneyProgress("a1b2c3d4")).toEqual({});
    expect(() => markJourneyMilestone("a1b2c3d4", "fix")).not.toThrow();
    getItem.mockRestore();
  });

  it("does not throw — and does not claim the mark — when the store is full", () => {
    const setItem = vi
      .spyOn(globalThis.localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    expect(markJourneyMilestone("a1b2c3d4", "download")).toBe(false);
    setItem.mockRestore();
    expect(readJourneyProgress("a1b2c3d4")).toEqual({});
  });
});

describe("completionOf — the pure read", () => {
  const ledger = [
    { key: "a", done: ["fix" as const, "download" as const] },
    { key: "b", done: ["match" as const] },
  ];

  it("returns only the asked-for résumé's milestones", () => {
    expect(completionOf(ledger, "a")).toEqual({ fix: true, download: true });
    expect(completionOf(ledger, "b")).toEqual({ match: true });
  });

  it("returns nothing for an unknown key and for no key at all", () => {
    expect(completionOf(ledger, "c")).toEqual({});
    expect(completionOf(ledger, null)).toEqual({});
  });
});

describe("withMilestone — the pure decision", () => {
  it("returns null when the milestone is already recorded", () => {
    const ledger = [{ key: "a", done: ["fix" as const] }];
    expect(withMilestone(ledger, "a", "fix")).toBeNull();
  });

  it("moves the touched résumé to the end without duplicating it", () => {
    const ledger = [
      { key: "a", done: ["fix" as const] },
      { key: "b", done: ["match" as const] },
    ];
    expect(withMilestone(ledger, "a", "download")).toEqual([
      { key: "b", done: ["match"] },
      { key: "a", done: ["fix", "download"] },
    ]);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import { buildSteeringSuffix } from "./steering.ts";

describe("buildSteeringSuffix", () => {
  it("returns empty string for undefined steering", () => {
    expect(buildSteeringSuffix(undefined)).toBe("");
  });

  it("returns empty string for empty steering object", () => {
    expect(buildSteeringSuffix({})).toBe("");
  });

  it("returns empty string for blank/whitespace-only instructions", () => {
    expect(buildSteeringSuffix({ userInstructions: "   " })).toBe("");
  });

  it("appends trimmed instructions verbatim after a blank line", () => {
    const suffix = buildSteeringSuffix({
      userInstructions: "  target a staff role  ",
    });
    expect(suffix).toBe(
      "\n\nThe user has these additional instructions: target a staff role",
    );
  });

  it("emits a page budget with older-experience compression guidance", () => {
    const suffix = buildSteeringSuffix({ pageTarget: 1 });
    expect(suffix.startsWith("\n\n")).toBe(true);
    expect(suffix).toContain("one-page");
    // The recency-compression instruction is the load-bearing half of the
    // page-target design (issue #210) — assert it's present for every tier.
    expect(suffix).toContain("older experience entries");
  });

  it.each([1, 2, 3] as const)(
    "includes the older-experience compression guidance for page target %i",
    (target) => {
      expect(buildSteeringSuffix({ pageTarget: target })).toContain(
        "older experience entries",
      );
    },
  );

  it("combines page budget then instructions, budget first", () => {
    const suffix = buildSteeringSuffix({
      pageTarget: 2,
      userInstructions: "lean technical",
    });
    const budgetIdx = suffix.indexOf("two-page");
    const instrIdx = suffix.indexOf("lean technical");
    expect(budgetIdx).toBeGreaterThan(-1);
    expect(instrIdx).toBeGreaterThan(-1);
    expect(budgetIdx).toBeLessThan(instrIdx);
    // Parts separated by a blank line.
    expect(suffix).toContain("\n\n");
  });

  it("distinguishes the three page tiers", () => {
    expect(buildSteeringSuffix({ pageTarget: 1 })).toContain("one-page");
    expect(buildSteeringSuffix({ pageTarget: 2 })).toContain("two-page");
    expect(buildSteeringSuffix({ pageTarget: 3 })).toContain("three-page");
  });
});

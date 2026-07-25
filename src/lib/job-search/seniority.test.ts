// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  SENIORITY_LADDER,
  seniorityRung,
  seniorityRungDistance,
} from "./seniority.ts";

describe("seniority ladder (issue 562)", () => {
  it("orders the IC rungs Intern < Junior < Mid < Senior < Staff < Principal", () => {
    expect(SENIORITY_LADDER.Intern).toBeLessThan(SENIORITY_LADDER.Junior);
    expect(SENIORITY_LADDER.Junior).toBeLessThan(SENIORITY_LADDER.Mid);
    expect(SENIORITY_LADDER.Mid).toBeLessThan(SENIORITY_LADDER.Senior);
    expect(SENIORITY_LADDER.Senior).toBeLessThan(SENIORITY_LADDER.Staff);
    expect(SENIORITY_LADDER.Staff).toBeLessThan(SENIORITY_LADDER.Principal);
  });

  it("offsets management rungs above their IC peers on the SAME ladder", () => {
    // Manager ≈ Staff + 1, Director ≈ Principal + 1, VP > Director, Exec > VP.
    expect(SENIORITY_LADDER.Manager).toBe(SENIORITY_LADDER.Staff + 1);
    expect(SENIORITY_LADDER.Director).toBe(SENIORITY_LADDER.Principal + 1);
    expect(SENIORITY_LADDER.VP).toBeGreaterThan(SENIORITY_LADDER.Director);
    expect(SENIORITY_LADDER.Executive).toBeGreaterThan(SENIORITY_LADDER.VP);
  });

  it("reads a Staff query as ~1 rung from a Manager posting", () => {
    expect(seniorityRungDistance("Staff", "Manager")).toBe(1);
  });

  it("reads a Director query as many rungs from a Junior posting", () => {
    // Director is heavily separated from an IC Junior...
    expect(seniorityRungDistance("Director", "Junior")).toBeGreaterThanOrEqual(5);
    // ...but only mildly from an adjacent-tier Manager.
    expect(seniorityRungDistance("Director", "Manager")).toBeLessThanOrEqual(2);
  });

  it("is symmetric", () => {
    expect(seniorityRungDistance("Director", "Junior")).toBe(
      seniorityRungDistance("Junior", "Director"),
    );
  });

  it("returns undefined (neutral) when either side has no recognizable level", () => {
    expect(seniorityRung(undefined)).toBeUndefined();
    expect(seniorityRung("Nonsense")).toBeUndefined();
    expect(seniorityRungDistance(undefined, "Staff")).toBeUndefined();
    expect(seniorityRungDistance("Staff", undefined)).toBeUndefined();
    expect(seniorityRungDistance("Staff", "Nonsense")).toBeUndefined();
  });
});

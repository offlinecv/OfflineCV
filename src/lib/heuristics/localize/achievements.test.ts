// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { localizeAchievements } from "./achievements.ts";
import { mkCascade } from "./__test-utils__.ts";

describe("localizeAchievements", () => {
  it("emits no defect when entries are parsed", () => {
    const cascade = mkCascade({
      fields: {
        heuristic_achievements: [
          { type: "Award", title: "Best Paper", year: "2022" },
        ],
      },
      sections: { achievements: ["Award · Best Paper, 2022"] },
    });
    const out = localizeAchievements(cascade);
    expect(out.defects).toEqual([]);
    expect(out.verdict).toBe("ok");
  });

  it("localizes achievements-parser-miss when the region is non-empty but nothing parsed", () => {
    const cascade = mkCascade({
      fields: { heuristic_achievements: [] },
      sections: { achievements: ["Award · Best Paper, 2022"] },
    });
    const out = localizeAchievements(cascade);
    expect(out.defects).toEqual(["achievements-parser-miss"]);
    expect(out.derived.achievementsParsedEmpty).toBe(true);
  });

  it("localizes achievements-under-segmented when entries trail header-shaped lines", () => {
    const cascade = mkCascade({
      fields: {
        heuristic_achievements: [
          { type: "Award", title: "Best Paper", year: "2022" },
        ],
      },
      sections: {
        achievements: [
          "Award · Best Paper, 2022",
          "- detail bullet",
          "Award · Second Prize, 2023",
        ],
      },
    });
    const out = localizeAchievements(cascade);
    expect(out.defects).toEqual(["achievements-under-segmented"]);
    expect(out.derived.achievementsEntriesFewerThanHeaderLines).toBe(true);
  });

  it("localizes achievements-no-section when no region segmented and nothing parsed", () => {
    const cascade = mkCascade({
      fields: { heuristic_achievements: [] },
      sections: {},
    });
    const out = localizeAchievements(cascade);
    expect(out.defects).toEqual(["achievements-no-section"]);
  });
});

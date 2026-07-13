// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  ACHIEVEMENT_PRESETS,
  matchAchievementPreset,
} from "./presets.ts";

describe("matchAchievementPreset (issue 456)", () => {
  it("matches a preset label case-insensitively", () => {
    expect(matchAchievementPreset("Patent")?.label).toBe("Patent");
    expect(matchAchievementPreset("patent")?.label).toBe("Patent");
    expect(matchAchievementPreset("  PATENT  ")?.label).toBe("Patent");
  });

  it("returns undefined for a label no preset covers — the normal parsed case", () => {
    // `type` is free text lifted from a real résumé. A miss is expected, not a
    // failure: the label still renders and still round-trips, just without an
    // emoji. It must NOT fuzzy-match onto "Award".
    expect(matchAchievementPreset("Best Paper Award")).toBeUndefined();
  });

  it("returns undefined for an absent or empty label", () => {
    expect(matchAchievementPreset(undefined)).toBeUndefined();
    expect(matchAchievementPreset("   ")).toBeUndefined();
  });

  it("carries a non-empty label and emoji on every preset, with unique labels", () => {
    const labels = ACHIEVEMENT_PRESETS.map((p) => p.label);
    for (const p of ACHIEVEMENT_PRESETS) {
      expect(p.label.trim()).not.toBe("");
      expect(p.emoji.trim()).not.toBe("");
    }
    expect(new Set(labels).size).toBe(labels.length);
  });
});

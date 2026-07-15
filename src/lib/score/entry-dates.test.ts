// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  buildProjectDates,
  buildEducationDates,
  splitAchievementType,
  ACHIEVEMENT_TYPE_MAX_LEN,
  achievementYearJoiner,
  isTightYearSeparator,
} from "./entry-dates.ts";

describe("buildProjectDates", () => {
  it("renders a closed range as start–end", () => {
    expect(
      buildProjectDates({ name: "P", start_date: "Jan 2023", end_date: "Mar 2023" }),
    ).toBe("Jan 2023–Mar 2023");
  });

  it("renders an open range as start–Present (is_current wins over end_date)", () => {
    expect(
      buildProjectDates({ name: "P", start_date: "Jan 2023", is_current: true }),
    ).toBe("Jan 2023–Present");
    expect(
      buildProjectDates({
        name: "P",
        start_date: "Jan 2023",
        end_date: "Mar 2023",
        is_current: true,
      }),
    ).toBe("Jan 2023–Present");
  });

  it("renders a lone start date", () => {
    expect(buildProjectDates({ name: "P", start_date: "2023" })).toBe("2023");
  });

  it("renders a lone is_current as Present", () => {
    expect(buildProjectDates({ name: "P", is_current: true })).toBe("Present");
  });

  it("renders a lone end date", () => {
    expect(buildProjectDates({ name: "P", end_date: "2023" })).toBe("2023");
  });

  it("returns empty string when no dates are present", () => {
    expect(buildProjectDates({ name: "P" })).toBe("");
  });
});

describe("buildEducationDates", () => {
  const base = { degree: "BS", institution: "U" };

  it("renders a closed range as start–end", () => {
    expect(
      buildEducationDates({ ...base, start_date: "Sep 2021", end_date: "May 2025" }),
    ).toBe("Sep 2021–May 2025");
  });

  it("prefers end_date alone (graduation date) over start", () => {
    expect(buildEducationDates({ ...base, end_date: "May 2027" })).toBe("May 2027");
  });

  it("falls back to a lone start date", () => {
    expect(buildEducationDates({ ...base, start_date: "Sep 2021" })).toBe(
      "Sep 2021",
    );
  });

  it("falls back to the bare year when no start/end parsed (#97)", () => {
    expect(buildEducationDates({ ...base, year: "2025" })).toBe("2025");
  });

  it("returns empty string when no date fields are present", () => {
    expect(buildEducationDates({ ...base })).toBe("");
  });
});

describe("splitAchievementType", () => {
  it("splits a canonical 'Type · description' title", () => {
    expect(splitAchievementType("Patent · Method for X")).toEqual({
      type: "Patent",
      rest: "Method for X",
    });
  });

  it("returns null when there is no ' · ' delimiter (whole title is prose)", () => {
    expect(splitAchievementType("Led the platform rewrite")).toBeNull();
  });

  it("returns null when the leading segment is too long to read as a label", () => {
    const longType = "A".repeat(ACHIEVEMENT_TYPE_MAX_LEN + 1);
    expect(splitAchievementType(`${longType} · detail`)).toBeNull();
  });

  it("keeps a type at exactly the max length", () => {
    const type = "A".repeat(ACHIEVEMENT_TYPE_MAX_LEN);
    expect(splitAchievementType(`${type} · detail`)).toEqual({ type, rest: "detail" });
  });

  it("splits on the FIRST delimiter, leaving later ' · ' in the rest", () => {
    expect(splitAchievementType("Award · Best Paper · ACL 2024")).toEqual({
      type: "Award",
      rest: "Best Paper · ACL 2024",
    });
  });

  it("returns null when the type segment is blank", () => {
    expect(splitAchievementType(" · orphan description")).toBeNull();
  });
});

describe("splitAchievementType — parse-time only (#456)", () => {
  // The split runs exactly once, in `extractAchievements`, and its result is
  // STORED as `HeuristicAchievement.type`. These cases are the reason nothing
  // downstream may re-derive the label from a composed string: re-splitting
  // "Type · Title" does not always return the pair it was built from.
  it("does not round-trip a label over the length cap", () => {
    const type = "x".repeat(ACHIEVEMENT_TYPE_MAX_LEN + 1);
    // Composing is lossless as a STRING, but the label no longer reads back —
    // a consumer that re-split would emphasize the whole line instead.
    expect(splitAchievementType(`${type} · runner-up`)).toBeNull();
  });

  it("does not round-trip a title that carries its own separator", () => {
    // Built from ("", "KubeCon · Amsterdam") — no type at all. Re-splitting the
    // composed string promotes the title's first segment to the type.
    expect(splitAchievementType("KubeCon · Amsterdam")).toEqual({
      type: "KubeCon",
      rest: "Amsterdam",
    });
  });
});

describe("achievementYearJoiner — the source's own title↔year separator (#380)", () => {
  it("falls back to the middot when the source used none", () => {
    expect(achievementYearJoiner(undefined)).toBe(" · ");
  });

  it("binds a comma tight to the title, with one space after", () => {
    // "Globex Engineering Excellence, 2021" — not " , 2021".
    expect(achievementYearJoiner(",")).toBe(", ");
    expect(isTightYearSeparator(",")).toBe(true);
  });

  it("gives a dash or a pipe air on both sides", () => {
    expect(achievementYearJoiner("–")).toBe(" – ");
    expect(achievementYearJoiner("|")).toBe(" | ");
    expect(isTightYearSeparator("–")).toBe(false);
  });
});

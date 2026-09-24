// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  firstUndatedRoleIndex,
  resolveRoleDisplay,
  roleHeadingLabel,
} from "./role-display.ts";

describe("resolveRoleDisplay", () => {
  const exp = {
    title: "Engineer",
    company: "Acme",
    location: "Chicago, IL",
    team: "Payments",
    start_date: "2019",
    end_date: "2022",
  };

  it("shows the parsed values when nothing is overridden", () => {
    expect(resolveRoleDisplay(exp, undefined)).toEqual({
      title: "Engineer",
      company: "Acme",
      location: "Chicago, IL",
      team: "Payments",
      startDate: "2019",
      endDate: "2022",
    });
  });

  it("lets an override win, and an empty override clear the field", () => {
    const d = resolveRoleDisplay(exp, { title: "Lead", start_date: "", team: "" });
    expect(d.title).toBe("Lead");
    expect(d.startDate).toBeUndefined();
    expect(d.team).toBeUndefined();
    expect(d.company).toBe("Acme");
  });

  it("treats an empty parsed value as absent", () => {
    expect(resolveRoleDisplay({ title: "" }, undefined).title).toBeUndefined();
  });

  it("reads an ongoing role as Present, from the parse or an override", () => {
    expect(resolveRoleDisplay({ ...exp, is_current: true }, undefined).endDate).toBe(
      "Present",
    );
    expect(resolveRoleDisplay(exp, { is_current: true }).endDate).toBe("Present");
    expect(
      resolveRoleDisplay({ ...exp, is_current: true }, { is_current: false }).endDate,
    ).toBe("2022");
  });
});

describe("roleHeadingLabel", () => {
  it("joins every part: Title — Company, Location · Team · dates", () => {
    expect(
      roleHeadingLabel({
        title: "Engineer",
        company: "Acme",
        location: "Chicago, IL",
        team: "Payments",
        start_date: "2019",
        end_date: "2022",
      }),
    ).toBe("Engineer — Acme, Chicago, IL · Payments · 2019 – 2022");
  });

  it("drops the separators of absent parts", () => {
    expect(roleHeadingLabel({ title: "Engineer" })).toBe("Engineer");
    expect(roleHeadingLabel({ company: "Acme", team: "Payments" })).toBe(
      "Acme · Payments",
    );
    expect(roleHeadingLabel({ location: "Remote", start_date: "2020" })).toBe(
      "Remote · 2020",
    );
    expect(roleHeadingLabel({ title: "", company: "" })).toBe("Untitled role");
  });

  it("anchors an end-only date as the start, like the export (#672)", () => {
    expect(roleHeadingLabel({ title: "Engineer", end_date: "2022" })).toBe(
      "Engineer · 2022",
    );
  });
});

describe("firstUndatedRoleIndex", () => {
  const dated = { title: "A", start_date: "2019" };
  const undated = { title: "B" };

  it("finds the first role with no start date, or -1", () => {
    expect(firstUndatedRoleIndex([dated, undated, undated])).toBe(1);
    expect(firstUndatedRoleIndex([dated, dated])).toBe(-1);
    expect(firstUndatedRoleIndex([])).toBe(-1);
  });

  it("reads each role through its overrides", () => {
    // A cleared date makes a role undated; a filled one dates it.
    expect(
      firstUndatedRoleIndex([dated, undated], (i) =>
        i === 0 ? { start_date: "" } : undefined,
      ),
    ).toBe(0);
    expect(
      firstUndatedRoleIndex([dated, undated], (i) =>
        i === 1 ? { start_date: "2021" } : undefined,
      ),
    ).toBe(-1);
  });
});

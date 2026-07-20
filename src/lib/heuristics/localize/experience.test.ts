// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { localizeExperience } from "./experience.ts";
import { mkCascade } from "./__test-utils__.ts";

describe("localizeExperience", () => {
  it("emits no defect when entry count matches date-range lines", () => {
    const cascade = mkCascade({
      fields: {
        experience: [
          { title: "Engineer", company: "Acme", start_date: "2020", end_date: "2022" },
        ],
      },
      sections: { experience: ["Engineer, Acme", "Jan 2020 – Jan 2022"] },
    });
    const out = localizeExperience(cascade);
    expect(out.defects).toEqual([]);
    expect(out.verdict).toBe("ok");
  });

  it("localizes experience-parser-miss when 0 entries but the region has date ranges", () => {
    const cascade = mkCascade({
      fields: { experience: [] },
      sections: { experience: ["Engineer, Acme", "Jan 2020 – Jan 2022"] },
    });
    const out = localizeExperience(cascade);
    expect(out.defects).toEqual(["experience-parser-miss"]);
    expect(out.derived.experienceRegionHasDateRangeLines).toBe(true);
  });

  it("localizes experience-under-segmented when entries trail date-range lines", () => {
    const cascade = mkCascade({
      fields: {
        experience: [
          { title: "Engineer", company: "Acme", start_date: "2020", end_date: "2021" },
        ],
      },
      sections: {
        experience: [
          "Engineer, Acme",
          "Jan 2020 – Jan 2021",
          "Manager, Beta",
          "Feb 2021 – Feb 2022",
        ],
      },
    });
    const out = localizeExperience(cascade);
    expect(out.defects).toEqual(["experience-under-segmented"]);
    expect(out.derived.experienceEntriesFewerThanDateRangeLines).toBe(true);
  });
});

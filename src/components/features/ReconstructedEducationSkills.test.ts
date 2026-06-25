// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  resolveEduValue,
  resolveEducationDisplay,
} from "./ReconstructedEducationSkills.tsx";
import type { ResumeEducation } from "../../lib/score/types.ts";

describe("resolveEduValue", () => {
  it("falls back to the parsed value when no override is present", () => {
    expect(resolveEduValue("BSc CS", undefined)).toBe("BSc CS");
  });

  it("normalizes a missing parsed value to undefined", () => {
    expect(resolveEduValue(undefined, undefined)).toBeUndefined();
    expect(resolveEduValue("", undefined)).toBeUndefined();
  });

  it("uses a non-empty override over the parsed value", () => {
    expect(resolveEduValue("BSc CS", "MSc CS")).toBe("MSc CS");
  });

  it('treats an empty-string override as an explicit clear ("not detected")', () => {
    expect(resolveEduValue("BSc CS", "")).toBeUndefined();
  });
});

describe("resolveEducationDisplay", () => {
  const base: ResumeEducation = {
    degree: "BSc Computer Science",
    institution: "State University",
    start_date: "2018",
    end_date: "2022",
    coursework: ["Algorithms", "Databases"],
  };

  it("passes parsed fields through when there are no overrides", () => {
    const d = resolveEducationDisplay(base, undefined);
    expect(d.degree).toBe("BSc Computer Science");
    expect(d.institution).toBe("State University");
    expect(d.startDate).toBe("2018");
    expect(d.endDate).toBe("2022");
    expect(d.dates).toBe("2018–2022");
    expect(d.coursework).toEqual(["Algorithms", "Databases"]);
  });

  it("applies field overrides and reflects date edits in the compact string", () => {
    const d = resolveEducationDisplay(base, {
      degree: "MSc Computer Science",
      end_date: "2024",
    });
    expect(d.degree).toBe("MSc Computer Science");
    expect(d.institution).toBe("State University"); // unchanged
    expect(d.endDate).toBe("2024");
    expect(d.dates).toBe("2018–2024");
  });

  it("clears a field when its override is an empty string", () => {
    const d = resolveEducationDisplay(base, { institution: "" });
    expect(d.institution).toBeUndefined();
  });

  it("collapses the dates string when both dates are cleared", () => {
    const noYear: ResumeEducation = { ...base, year: undefined };
    const d = resolveEducationDisplay(noYear, { start_date: "", end_date: "" });
    expect(d.startDate).toBeUndefined();
    expect(d.endDate).toBeUndefined();
    expect(d.dates).toBe("");
  });

  it("falls back to year when only a single graduation date exists", () => {
    const grad: ResumeEducation = {
      degree: "BSc",
      institution: "U",
      year: "2025",
    };
    const d = resolveEducationDisplay(grad, undefined);
    expect(d.startDate).toBeUndefined();
    expect(d.endDate).toBeUndefined();
    expect(d.dates).toBe("2025");
  });

  it("defaults coursework to an empty array when absent", () => {
    const noCoursework: ResumeEducation = {
      degree: "BSc",
      institution: "U",
    };
    expect(resolveEducationDisplay(noCoursework, undefined).coursework).toEqual(
      [],
    );
  });
});

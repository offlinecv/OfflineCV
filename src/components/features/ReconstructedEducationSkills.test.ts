// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EducationSection } from "./ReconstructedEducationSkills.tsx";
import {
  resolveEduValue,
  resolveEducationDisplay,
} from "../../lib/edit/education-display.ts";
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

  it("surfaces the major (field), passing it through and applying its override", () => {
    const withMajor: ResumeEducation = {
      ...base,
      field: "Computer Science & Engineering",
    };
    expect(resolveEducationDisplay(withMajor, undefined).field).toBe(
      "Computer Science & Engineering",
    );
    // Override replaces; an empty-string override clears the major.
    expect(resolveEducationDisplay(withMajor, { field: "Data Science" }).field).toBe(
      "Data Science",
    );
    expect(resolveEducationDisplay(withMajor, { field: "" }).field).toBeUndefined();
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

  it("resolves gpa and honors, and applies their overrides (#883)", () => {
    const edu: ResumeEducation = {
      degree: "B.S.",
      institution: "State University",
      gpa: "3.72/4.00",
      honors: "cum laude",
    };
    expect(resolveEducationDisplay(edu, undefined)).toMatchObject({
      gpa: "3.72/4.00",
      honors: "cum laude",
    });
    expect(
      resolveEducationDisplay(edu, { gpa: "8.4/10", honors: "" }),
    ).toMatchObject({ gpa: "8.4/10", honors: undefined });
  });

  it("surfaces gpa and honors a parse never found, so the field can be added", () => {
    expect(
      resolveEducationDisplay(
        { degree: "B.S.", institution: "State University" },
        { gpa: "First Class" },
      ),
    ).toMatchObject({ gpa: "First Class", honors: undefined });
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

describe("EducationSection date-row symmetry (issue 376)", () => {
  // The `–` separator between start/end EditableFields must render identically
  // regardless of which side is empty; only the empty side switches to the
  // strengthened "+ " placeholder treatment. Static (read-mode) render, so
  // renderToStaticMarkup is sufficient — matches the EditableField primitive's
  // own test harness.
  function renderSection(edu: ResumeEducation): string {
    return renderToStaticMarkup(
      createElement(EducationSection, {
        education: [edu],
        educationOverrides: {},
        onEducationFieldChange: () => {},
        addedEducation: [],
        originalCount: 1,
        // Identity: nothing is deleted in this harness, so a render position IS
        // its parsed index (#856).
        parsedIndices: [0],
        onAddEntry: () => {},
        onRemoveEntry: () => {},
        onEntryField: () => {},
        onPruneEmpty: () => {},
      }),
    );
  }

  it("renders the dash with both sides populated, neither prefixed", () => {
    const html = renderSection({
      degree: "BSc",
      institution: "U",
      start_date: "2018",
      end_date: "2022",
    });
    expect(html).toContain(">2018<");
    expect(html).toContain(">2022<");
    expect(html).toContain("–");
    expect(html).not.toContain("+ 2018");
    expect(html).not.toContain("+ 2022");
  });

  it("prefixes only the empty start side; the dash and the populated end side are unchanged", () => {
    const html = renderSection({
      degree: "BSc",
      institution: "U",
      end_date: "2022",
    });
    expect(html).toContain(`<span aria-hidden="true">+ </span>start`);
    expect(html).toContain(">2022<");
    expect(html).toContain("–");
  });

  it("prefixes only the empty end side; the dash and the populated start side are unchanged", () => {
    const html = renderSection({
      degree: "BSc",
      institution: "U",
      start_date: "2009",
    });
    expect(html).toContain(">2009<");
    expect(html).toContain(`<span aria-hidden="true">+ </span>end`);
    expect(html).toContain("–");
  });

  it("prefixes both sides when both start and end are absent", () => {
    const html = renderSection({
      degree: "BSc",
      institution: "U",
    });
    expect(html).toContain(`<span aria-hidden="true">+ </span>start`);
    expect(html).toContain(`<span aria-hidden="true">+ </span>end`);
    expect(html).toContain("–");
  });
});

describe("EducationSection GPA / honors row (#883)", () => {
  function renderSection(edu: ResumeEducation, addedCount = 0): string {
    return renderToStaticMarkup(
      createElement(EducationSection, {
        education: [edu],
        educationOverrides: {},
        onEducationFieldChange: () => {},
        addedEducation: addedCount
          ? [{ id: "added:edu:0", section: "education" as const, title: "" }]
          : [],
        originalCount: addedCount ? 0 : 1,
        parsedIndices: addedCount ? [] : [0],
        onAddEntry: () => {},
        onRemoveEntry: () => {},
        onEntryField: () => {},
        onPruneEmpty: () => {},
      }),
    );
  }

  it("renders both values, labelling only the grade", () => {
    const html = renderSection({
      degree: "B.S.",
      institution: "State University",
      gpa: "3.72/4.00",
      honors: "cum laude",
    });
    expect(html).toContain(">cum laude<");
    expect(html).toContain(">3.72/4.00<");
    expect(html).toContain(">GPA:<");
  });

  it("offers an add affordance for each field the parse missed (AC#4)", () => {
    const html = renderSection({ degree: "B.S.", institution: "State University" });
    expect(html).toContain(`<span aria-hidden="true">+ </span>honors`);
    expect(html).toContain(`<span aria-hidden="true">+ </span>GPA`);
    // No static "GPA:" label in front of an empty field — it would read as
    // "GPA: + GPA"; the add affordance already names the thing.
    expect(html).not.toContain(">GPA:<");
  });

  it("renders no such row on a user-ADDED entry, which has no slot for either", () => {
    const html = renderSection({ degree: "", institution: "" }, 1);
    expect(html).not.toContain("honors");
    expect(html).not.toContain("GPA");
  });
});
